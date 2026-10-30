import { and, eq, isNull } from "drizzle-orm";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { user, workspaceSessions, workspaces } from "@agentbox/db/schema";
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

/**
 * Typed-slug confirmed delete of any workspace that is not already going away: sets `deleting`,
 * revokes workspace sessions and queues `delete_tenant` (the worker finishes with `deleted`).
 * The owner is suspended so they cannot reach anything, except admins: suspending an admin
 * (`isAdminUser` needs `accessStatus = active`) would lock them out of /admin, and an admin's
 * own access to the console must never depend on having a workspace.
 */
export async function deleteWorkspaceAsAdmin(
  database: Db,
  actor: LifecycleActor,
  slug: string,
  confirm: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const ws = await loadWorkspace(tx, slug);
    if (confirm !== ws.slug) throw new UserError("Type the workspace slug to confirm");
    if (ws.status === "deleting" || ws.status === "deleted") throw new UserError("Already deleted");
    const owner = (await tx.select().from(user).where(eq(user.id, ws.userId)).limit(1))[0];
    const suspend = owner?.role !== "admin";
    await tx.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.id, ws.id));
    if (suspend) {
      await tx.update(user).set({ accessStatus: "suspended" }).where(eq(user.id, ws.userId));
    }
    await tx
      .update(workspaceSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceSessions.userId, ws.userId), isNull(workspaceSessions.revokedAt)));
    await enqueueWorkspaceJob(tx, ws.id, { type: "delete_tenant" });
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
      },
      ip: actor.ip,
    });
  });
}
