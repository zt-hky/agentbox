"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action";
import {
  adminDeleteWorkspace,
  adminResetStartFailures,
  adminRestartWorkspace,
  adminStartWorkspace,
  adminStopWorkspace,
} from "./actions";

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b py-4 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0 max-w-prose">
        <h3 className="text-sm">{title}</h3>
        <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}

export function ManagePanel({
  slug,
  status,
  startFailures,
  ownerId,
  ownerEmail,
  planName,
  isOwnerSelf,
}: {
  slug: string;
  status: string;
  startFailures: number;
  ownerId: string;
  ownerEmail: string;
  planName: string | null;
  isOwnerSelf: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<ActionResult<unknown>>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(success);
        router.refresh();
      }
    });
  // ConfirmDialog shows the error itself, so it gets the raw result and refreshes on success.
  const confirmed = async (fn: () => Promise<ActionResult<unknown>>) => {
    const res = await fn();
    if (res.ok) router.refresh();
    return res;
  };

  const canStart = status === "sleeping" || status === "error";
  const canStop = status === "running" || status === "starting";
  const gone = status === "deleting" || status === "deleted";

  return (
    <div className="grid">
      <Row title="Start" description="Wake the workspace. It is ready in about 10 seconds.">
        <Button
          size="sm"
          disabled={pending || !canStart}
          onClick={() => run(() => adminStartWorkspace(slug), "Start queued")}
        >
          Start
        </Button>
      </Row>
      <Row
        title="Stop"
        description="Stop the container now. Unsaved work in running terminals and agents is lost."
      >
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={pending || !canStop}>
              Stop
            </Button>
          }
          title={`Stop ${slug}?`}
          description="Running terminals and agents end immediately. Files on disk are kept."
          confirmLabel="Stop workspace"
          onConfirm={() => confirmed(() => adminStopWorkspace(slug))}
        />
      </Row>
      <Row
        title="Restart"
        description="Stop, then start again. Use it when the workspace is running but misbehaving."
      >
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={pending || status !== "running"}>
              Restart
            </Button>
          }
          title={`Restart ${slug}?`}
          description="Running terminals and agents end, then the workspace boots again."
          confirmLabel="Restart workspace"
          onConfirm={() => confirmed(() => adminRestartWorkspace(slug))}
        />
      </Row>
      <Row
        title="Start failures"
        description={
          startFailures > 0
            ? `${startFailures} failed ${startFailures === 1 ? "start" : "starts"} in a row. Reset the counter after fixing the cause so the next start is not held back.`
            : "No failed starts recorded."
        }
      >
        <Button
          size="sm"
          variant="outline"
          disabled={pending || startFailures === 0}
          onClick={() => run(() => adminResetStartFailures(slug), "Start failures reset")}
        >
          Reset counter
        </Button>
      </Row>
      <Row
        title="Plan"
        description={`${planName ?? "No plan"} for ${ownerEmail}. Plans belong to the user, so change it there.`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href={`/admin/users/${ownerId}`}>Open user</Link>
        </Button>
      </Row>
      <Row
        title="Delete workspace"
        description={
          isOwnerSelf
            ? "You cannot delete your own workspace."
            : "Destroys the container, the Linux account and all workspace data, and suspends the user's access. This cannot be undone."
        }
      >
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="destructive" disabled={pending || gone || isOwnerSelf}>
              Delete
            </Button>
          }
          title={`Delete ${slug}?`}
          description="The container, Linux account and all workspace data are destroyed, and the user's access is suspended."
          confirmLabel="Delete workspace"
          destructive
          confirmText={slug}
          onConfirm={() => confirmed(() => adminDeleteWorkspace(slug, slug))}
        />
      </Row>
    </div>
  );
}
