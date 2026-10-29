"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
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
import type { ActionResult } from "@/lib/action";
import type { ImageVersions } from "@/lib/admin/system";
import { formatDateTime } from "@/lib/format";
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
  versions: ImageVersions | null;
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
    <CodeBlock
      text={log || "Waiting for build output..."}
      label="Build log"
      maxHeight="18rem"
      wrap
    />
  );
}

function ScanBadges({ scan }: { scan: ImageRow["scan"] }) {
  if (!scan) return <span className="text-meta text-muted-foreground">No scan results</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant={scan.counts.CRITICAL ? "destructive" : "outline"}>
        Critical {scan.counts.CRITICAL ?? 0}
      </Badge>
      <Badge variant="outline">High {scan.counts.HIGH ?? 0}</Badge>
      <Badge variant="outline">Medium {scan.counts.MEDIUM ?? 0}</Badge>
      <Badge variant="outline">Low {scan.counts.LOW ?? 0}</Badge>
      {scan.fixableCritical > 0 ? (
        <Badge variant="destructive">{scan.fixableCritical} fixable critical</Badge>
      ) : null}
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
            New and restarted workspaces will use this image. The current active image becomes
            ready.
          </DialogDescription>
        </DialogHeader>
        <ScanBadges scan={row.scan} />
        {needsOverride ? (
          <div className="space-y-1.5">
            <Label htmlFor="override">
              {row.scan ? "Fixable critical vulnerabilities found" : "No scan results"}: override
              reason (required)
            </Label>
            <Textarea
              id="override"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
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

function ImageEntry({
  r,
  onActivate,
  busy,
}: {
  r: ImageRow;
  onActivate: () => void;
  busy: boolean;
}) {
  const router = useRouter();
  const run = async (fn: () => Promise<ActionResult>, message: string) => {
    const res = await fn();
    if (res.ok) {
      toast.success(message);
      router.refresh();
    }
    return res;
  };
  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <StatusBadge status={r.status} />
          <span className="truncate font-medium">
            <Mono>{r.t3Ref}</Mono>
          </span>
        </div>
        <span className="text-meta text-muted-foreground">
          {formatDateTime(new Date(r.createdAt))}
        </span>
        <div className="ml-auto flex gap-2">
          {r.status === "ready" ? (
            <>
              <Button size="sm" onClick={onActivate} disabled={busy}>
                Activate
              </Button>
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline" disabled={busy}>
                    Retire
                  </Button>
                }
                title={`Retire ${r.t3Ref}?`}
                description="It stays on disk but can no longer be activated. You can delete it afterwards."
                confirmLabel="Retire image"
                onConfirm={() => run(() => retireImage(r.id), "Image retired")}
              />
            </>
          ) : null}
          {r.status !== "active" && r.status !== "building" ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" disabled={busy}>
                  Delete
                </Button>
              }
              title={`Delete ${r.t3Ref}?`}
              description="The image files are removed from the host. This cannot be undone."
              confirmLabel="Delete image"
              destructive
              onConfirm={() => run(() => deleteImage(r.id), "Delete queued")}
            />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-meta text-muted-foreground">
        {r.imageId ? (
          <span>
            Image ID <Mono className="text-foreground">{r.imageId.slice(0, 12)}</Mono>
          </span>
        ) : null}
        {r.status === "building" || r.status === "failed" ? null : <ScanBadges scan={r.scan} />}
      </div>
      {r.overrideReason ? (
        <p className="text-meta text-muted-foreground">
          Activated with an override: {r.overrideReason}
        </p>
      ) : null}
      {r.versions ? (
        <details className="group text-meta">
          <summary className="w-fit cursor-pointer rounded-md text-signal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Tools in this image
          </summary>
          <dl className="mt-2 grid max-w-xl gap-x-6 gap-y-1 sm:grid-cols-[8rem_1fr]">
            {r.versions.map((v) => (
              <div key={v.label} className="contents">
                <dt className="text-muted-foreground">{v.label}</dt>
                <dd className="break-words">
                  <Mono>{v.value}</Mono>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {r.status === "failed" && r.buildLog ? (
        <details className="text-meta">
          <summary className="w-fit cursor-pointer rounded-md text-signal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Build log
          </summary>
          <div className="mt-2">
            <CodeBlock text={r.buildLog} label="Build log" maxHeight="16rem" wrap />
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function ImagesPanel({ rows }: { rows: ImageRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [t3Ref, setT3Ref] = useState("omp-overlay");
  const [activating, setActivating] = useState<ImageRow | null>(null);
  const building = rows.filter((r) => r.status === "building");

  return (
    <>
      <Section
        title="Build a new image"
        description="Builds take several minutes. Only one build can run at a time."
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const res = await buildImage(t3Ref);
              if (!res.ok) toast.error(res.error);
              else {
                toast.success("Build queued");
                router.refresh();
              }
            });
          }}
        >
          <div className="w-full space-y-1.5 sm:w-80">
            <Label htmlFor="t3ref">T3 ref (branch, tag or commit)</Label>
            <Input
              id="t3ref"
              value={t3Ref}
              onChange={(e) => setT3Ref(e.target.value)}
              className="font-mono"
            />
          </div>
          <Button type="submit" disabled={pending || building.length > 0}>
            Build image
          </Button>
        </form>
        {building.map((r) => (
          <div key={r.id} className="mt-5 space-y-2">
            <p className="text-sm font-medium">
              Building <Mono>{r.t3Ref}</Mono>
            </p>
            <BuildLog id={r.id} initial={r.buildLog} />
          </div>
        ))}
      </Section>

      <Section title="Images" bodyClassName="p-0">
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No images yet"
              description="Build one above so workspaces can start."
            />
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <ImageEntry key={r.id} r={r} busy={pending} onActivate={() => setActivating(r)} />
            ))}
          </ul>
        )}
      </Section>
      {activating ? <ActivateDialog row={activating} onClose={() => setActivating(null)} /> : null}
    </>
  );
}
