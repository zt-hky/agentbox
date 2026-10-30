"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AdminSleepButton } from "../admin-sleep-button";
import { ApproveUserButton } from "@/app/admin/users/[id]/user-controls";
import type { PlanOption } from "@/components/grant-access-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Mono } from "@/components/mono";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { shortImageId, type ImageOption, type WorkspaceImageState } from "@/lib/admin/image-view";
import type { ActionResult } from "@/lib/action";
import {
  adminDeleteWorkspace,
  adminResetStartFailures,
  adminRestartWorkspace,
  adminSetWorkspaceImage,
  adminStartWorkspace,
} from "./actions";

export interface WorkspaceImagePanel {
  /** Images this workspace may use (ready/active, or retired with files). */
  options: ImageOption[];
  /** The image row matching what the container last started with, if it still exists. */
  current: ImageOption | null;
  currentImageId: string | null;
  pinnedImageRowId: string | null;
  state: WorkspaceImageState;
}

const FOLLOW = "follow";

const STATE_BADGE: Record<
  WorkspaceImageState,
  { label: string; variant: "outline" | "destructive" }
> = {
  active: { label: "Active image", variant: "outline" },
  outdated: { label: "Outdated", variant: "destructive" },
  pinned: { label: "Pinned", variant: "outline" },
  "pinned-pending": { label: "Pinned, applies on next start", variant: "outline" },
  unknown: { label: "Not started yet", variant: "outline" },
};

export const imageOptionLabel = (o: ImageOption) =>
  `${o.t3Ref}${o.t3Version ? ` (${o.t3Version})` : ""} · ${shortImageId(o.imageId)}${o.status === "active" ? " · active" : ""}`;

function ImageControl({
  slug,
  status,
  image,
  disabled,
  onApplied,
}: {
  slug: string;
  status: string;
  image: WorkspaceImagePanel;
  disabled: boolean;
  onApplied: () => void;
}) {
  const initial = image.pinnedImageRowId ?? FOLLOW;
  const [choice, setChoice] = useState(initial);
  const target = image.options.find((o) => o.id === choice) ?? null;
  const active = image.options.find((o) => o.status === "active") ?? null;
  const resulting = choice === FOLLOW ? active : target;
  const willRestart =
    status === "running" && resulting !== null && resulting.imageId !== image.currentImageId;
  const badge = STATE_BADGE[image.state];
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {image.current ? (
          <span className="text-meta">
            <Mono>{image.current.t3Ref}</Mono>
            {image.current.t3Version ? (
              <span className="text-muted-foreground"> ({image.current.t3Version})</span>
            ) : null}
          </span>
        ) : null}
        <Mono className="text-meta text-muted-foreground">
          {shortImageId(image.currentImageId)}
        </Mono>
        {image.current ? <StatusBadge status={image.current.status} /> : null}
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select value={choice} onValueChange={setChoice} disabled={disabled}>
          <SelectTrigger className="w-72" aria-label="Image for this workspace">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW}>
              Follow active image{active ? ` (${active.t3Ref})` : ""}
            </SelectItem>
            {image.options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {imageOptionLabel(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={disabled || choice === initial}>
              Apply
            </Button>
          }
          title={
            choice === FOLLOW ? "Follow the active image?" : `Pin ${slug} to ${target?.t3Ref}?`
          }
          description={
            willRestart
              ? "The workspace is running, so it restarts now: running terminals and agents end. Files stay."
              : status === "running"
                ? "The workspace already runs this image, so it is not restarted."
                : "It uses this image the next time it starts."
          }
          confirmLabel={willRestart ? "Apply and restart" : "Apply"}
          onConfirm={async () => {
            const res = await adminSetWorkspaceImage(slug, choice === FOLLOW ? null : choice);
            if (res.ok) onApplied();
            return res;
          }}
        />
      </div>
    </div>
  );
}

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
  recreate,
  image,
}: {
  slug: string;
  status: string;
  startFailures: number;
  ownerId: string;
  ownerEmail: string;
  planName: string | null;
  /** Set for a `deleted` workspace: the owner can get a fresh one. */
  recreate: {
    plans: PlanOption[];
    defaultPlanId: string;
    baseDomain: string;
  } | null;
  image: WorkspaceImagePanel;
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
        title="Sleep"
        description="Stop the container now. Open tabs disconnect and unsaved work in running terminals and agents is lost; files stay."
      >
        <AdminSleepButton slug={slug} status={status} ownerEmail={ownerEmail} disabled={pending} />
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
        title="Image"
        description="Follow the active image, or pin this workspace to a specific one to upgrade or roll back. A running workspace restarts onto it; a sleeping one uses it on its next start."
      >
        <ImageControl
          key={image.pinnedImageRowId ?? FOLLOW}
          slug={slug}
          status={status}
          image={image}
          disabled={pending || gone}
          onApplied={() => router.refresh()}
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
          "Destroys the container, the Linux account and all workspace data. Non-admin owners are suspended; an admin keeps console access. This cannot be undone."
        }
      >
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="destructive" disabled={pending || gone}>
              Delete
            </Button>
          }
          title={`Delete ${slug}?`}
          description="The container, Linux account and all workspace data are destroyed. A non-admin owner is suspended."
          confirmLabel="Delete workspace"
          destructive
          confirmText={slug}
          onConfirm={() => confirmed(() => adminDeleteWorkspace(slug, slug))}
        />
      </Row>
      {recreate ? (
        <Row
          title="Re-create workspace"
          description={`Provision a fresh workspace for ${ownerEmail}. The old slug can be reused; a new slot and identity secret are issued.`}
        >
          <ApproveUserButton
            label="Re-create workspace"
            mode="recreate"
            target={{ userId: ownerId, email: ownerEmail, suggestedSlug: slug }}
            plans={recreate.plans}
            defaultPlanId={recreate.defaultPlanId}
            baseDomain={recreate.baseDomain}
          />
        </Row>
      ) : null}
    </div>
  );
}
