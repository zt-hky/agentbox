"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { activateImage, buildImage, deleteImage, pollImage, retireImage } from "./actions";

export interface ImageRow {
  id: string;
  imageId: string | null;
  t3Ref: string;
  status: string;
  createdAt: string;
  buildLog: string;
  overrideReason: string | null;
  scan: { counts: Record<string, number>; fixableCritical: number } | null;
}

export const POLL_INTERVAL_MS = 3000;

function BuildLog({ id, initial }: { id: string; initial: string }) {
  const router = useRouter();
  const [log, setLog] = useState(initial);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const res = await pollImage(id);
      if (stopped) return;
      if (res.ok) {
        setLog(res.data.buildLog);
        if (res.data.status !== "building") {
          router.refresh(); // leaves `building`: stop polling
          return;
        }
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, router]);
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
      {log || "Waiting for build output..."}
    </pre>
  );
}

function ScanBadges({ scan }: { scan: ImageRow["scan"] }) {
  if (!scan) return <span className="text-muted-foreground">no scan</span>;
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={scan.counts.CRITICAL ? "destructive" : "outline"}>C {scan.counts.CRITICAL ?? 0}</Badge>
      <Badge variant="outline">H {scan.counts.HIGH ?? 0}</Badge>
      <Badge variant="outline">M {scan.counts.MEDIUM ?? 0}</Badge>
      <Badge variant="outline">L {scan.counts.LOW ?? 0}</Badge>
      {scan.fixableCritical > 0 ? <Badge variant="destructive">{scan.fixableCritical} fixable critical</Badge> : null}
    </div>
  );
}

function ActivateDialog({ row, onClose }: { row: ImageRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const needsOverride = row.scan === null || row.scan.fixableCritical > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate {row.t3Ref}</DialogTitle>
          <DialogDescription>
            New and restarted workspaces will use this image. The current active image becomes ready.
          </DialogDescription>
        </DialogHeader>
        <ScanBadges scan={row.scan} />
        {needsOverride ? (
          <div className="space-y-1.5">
            <Label htmlFor="override">
              {row.scan ? "Fixable CRITICAL vulnerabilities found" : "No scan results"}: override reason (required)
            </Label>
            <Textarea id="override" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending || (needsOverride && !reason.trim())}
            onClick={() =>
              start(async () => {
                const res = await activateImage(row.id, needsOverride ? reason : null);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success("Image activated");
                onClose();
                router.refresh();
              })
            }
          >
            Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImagesPanel({ rows }: { rows: ImageRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [t3Ref, setT3Ref] = useState("omp-overlay");
  const [activating, setActivating] = useState<ImageRow | null>(null);
  const building = rows.filter((r) => r.status === "building");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Failed");
      else {
        toast.success(success);
        router.refresh();
      }
    });

  return (
    <div className="space-y-6">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => buildImage(t3Ref), "Build queued");
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="t3ref">T3 ref (branch, tag or commit)</Label>
          <Input id="t3ref" value={t3Ref} onChange={(e) => setT3Ref(e.target.value)} className="w-72" />
        </div>
        <Button type="submit" disabled={pending || building.length > 0}>
          Build image
        </Button>
      </form>

      {building.map((r) => (
        <div key={r.id} className="space-y-2">
          <div className="text-sm font-medium">Building {r.t3Ref}</div>
          <BuildLog id={r.id} initial={r.buildLog} />
        </div>
      ))}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Image</TableHead>
              <TableHead>Scan</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                  No images yet. Build one to let workspaces start.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.t3Ref}
                    {r.overrideReason ? (
                      <div className="text-xs font-normal text-muted-foreground">override: {r.overrideReason}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.imageId ? r.imageId.slice(0, 12) : ""}</TableCell>
                  <TableCell>{r.status === "building" ? "" : <ScanBadges scan={r.scan} />}</TableCell>
                  <TableCell>{r.createdAt.slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {r.status === "ready" ? (
                        <>
                          <Button size="sm" onClick={() => setActivating(r)} disabled={pending}>
                            Activate
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => run(() => retireImage(r.id), "Image retired")}
                          >
                            Retire
                          </Button>
                        </>
                      ) : null}
                      {r.status !== "active" && r.status !== "building" ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => run(() => deleteImage(r.id), "Delete queued")}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {activating ? <ActivateDialog row={activating} onClose={() => setActivating(null)} /> : null}
    </div>
  );
}
