"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { adminDeleteWorkspace, adminStartWorkspace, adminStopWorkspace } from "./actions";

export function WorkspaceControls({ slug, status }: { slug: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Failed");
      else {
        toast.success(success);
        setOpen(false);
        router.refresh();
      }
    });

  const deleted = status === "deleting" || status === "deleted";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        disabled={pending || (status !== "sleeping" && status !== "error")}
        onClick={() => run(() => adminStartWorkspace(slug), "Start queued")}
      >
        Start
      </Button>
      <Button
        variant="outline"
        disabled={pending || (status !== "running" && status !== "starting")}
        onClick={() => run(() => adminStopWorkspace(slug), "Stop queued")}
      >
        Stop
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive" disabled={pending || deleted}>
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {slug}?</DialogTitle>
            <DialogDescription>
              The container, Linux account and all workspace data are destroyed, and the user&apos;s
              access is suspended. Type <strong>{slug}</strong> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={pending || confirm !== slug}
              onClick={() => run(() => adminDeleteWorkspace(slug, confirm), "Deletion queued")}
            >
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
