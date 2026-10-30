import { and, eq, isNull } from "drizzle-orm";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { clearAgentKeys } from "../agent-keys";
import { writeAudit } from "../audit";
import type { Db } from "../db-types";
import { UserError } from "../errors";
import { enqueueWorkspaceJob } from "../jobs";

export interface LifecycleActor {
  adminId: string;
  ip: string | null;
}

/** Statuses an admin may put to sleep: an errored container can still exist. */
export const STOPPABLE_STATUSES = ["running", "starting", "error"] as const;

async function loadWorkspace(tx: Pick<Db, "select">, slug: string) {
  const rows = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, wsSlugSchema.parse(slug)))
    .limit(1);
  if (!rows[0]) throw new UserError("Workspace not found");
  return rows[0];
}

/** Queue `stop_workspace` (reason admin) for any workspace, the admin's own included. */
export async function stopWorkspaceAsAdmin(
  database: Db,
  actor: LifecycleActor,
  slug: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const ws = await loadWorkspace(tx, slug);
    if (!(STOPPABLE_STATUSES as readonly string[]).includes(ws.status)) {
      throw new UserError(`Cannot stop a workspace that is ${ws.status}`);
    }
    await enqueueWorkspaceJob(tx, ws.id, { type: "stop_workspace", reason: "admin" });
    await writeAudit(tx, {
      actorId: actor.adminId,
      action: "workspace.stop",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { slug: ws.slug, previousStatus: ws.status },
      ip: actor.ip,
    });
  });
}

export type AdminAfterDelete = "onboard" | "suspend";

/**
 * Typed-slug confirmed delete of any workspace that is not already going away: sets `deleting`,
 * revokes workspace sessions and queues `delete_tenant` (the worker finishes with `deleted`).
 * `keepData` keeps the tenant home so re-creation adopts it; otherwise it is wiped along with the
 * saved tool selection and agent keys. The owner must onboard again either way; `suspend` also
 * suspends them, except admins: suspending an admin (`isAdminUser` needs `accessStatus = active`)
 * would lock them out of /admin, and an admin's console access must never depend on a workspace.
 */
export async function deleteWorkspaceAsAdmin(
  database: Db,
  actor: LifecycleActor,
  slug: string,
  input: { confirm: string; keepData: boolean; afterDelete: AdminAfterDelete },
): Promise<void> {
  await database.transaction(async (tx) => {
    const ws = await loadWorkspace(tx, slug);
    if (input.confirm !== ws.slug) throw new UserError("Type the workspace slug to confirm");
    if (ws.status === "deleting" || ws.status === "deleted") throw new UserError("Already deleted");
    const owner = (await tx.select().from(user).where(eq(user.id, ws.userId)).limit(1))[0];
    const suspend = input.afterDelete === "suspend" && owner?.role !== "admin";
    await tx.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.id, ws.id));
    await tx
      .update(user)
      .set({
        ...(input.keepData
          ? { onboardedAt: null }
          : { onboardedAt: null, onboardingSelection: null }),
        ...(suspend ? { accessStatus: "suspended" as const } : {}),
      })
      .where(eq(user.id, ws.userId));
    if (!input.keepData) await clearAgentKeys(tx, ws.userId);
    await tx
      .update(workspaceSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceSessions.userId, ws.userId), isNull(workspaceSessions.revokedAt)));
    await enqueueWorkspaceJob(tx, ws.id, { type: "delete_tenant", keepData: input.keepData });
    await writeAudit(tx, {
      actorId: actor.adminId,
      action: "workspace.delete",
      targetType: "workspace",
      targetId: ws.id,
      metadata: {
        slug: ws.slug,
        userId: ws.userId,
        previousStatus: ws.status,
        suspendedOwner: suspend,
        keepData: input.keepData,
        afterDelete: input.afterDelete,
      },
      ip: actor.ip,
    });
  });
}
