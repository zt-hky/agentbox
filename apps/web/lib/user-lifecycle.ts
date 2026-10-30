import { and, eq, isNull } from "drizzle-orm";
import { user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { clearAgentKeys } from "./agent-keys";
import { writeAudit } from "./audit";
import type { Db } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";

export interface UserLifecycleActor {
  userId: string;
  ip: string | null;
}

async function ownWorkspace(tx: Pick<Db, "select">, userId: string) {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1);
  if (!ws || ws.status === "deleted") throw new UserError("You do not have a workspace");
  return ws;
}

/** Restart the user's workspace (running: stop + start; sleeping or errored: start). */
export async function restartOwnWorkspace(database: Db, actor: UserLifecycleActor): Promise<void> {
  await database.transaction(async (tx) => {
    const ws = await ownWorkspace(tx, actor.userId);
    if (!["running", "sleeping", "error"].includes(ws.status)) {
      throw new UserError(`Cannot restart a workspace that is ${ws.status}`);
    }
    await enqueueWorkspaceJob(tx, ws.id, { type: "restart_workspace" });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "workspace.restart",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { slug: ws.slug, previousStatus: ws.status, self: true },
      ip: actor.ip,
    });
  });
}

/**
 * User-initiated delete, type-the-slug confirmed. `keepData` keeps the tenant home on the host so
 * re-creating the workspace adopts it (same slug and slot); otherwise everything is wiped, and the
 * saved tool selection and agent keys go with it. Either way the user must onboard again
 * (`onboardedAt` cleared), the workspace becomes `deleting` and its sessions are revoked.
 */
export async function deleteOwnWorkspace(
  database: Db,
  actor: UserLifecycleActor,
  input: { keepData: boolean; confirmSlug: string },
): Promise<void> {
  await database.transaction(async (tx) => {
    const ws = await ownWorkspace(tx, actor.userId);
    if (input.confirmSlug !== ws.slug) throw new UserError("Type the workspace name to confirm");
    if (ws.status === "deleting") throw new UserError("Your workspace is already being deleted");
    if (ws.status === "provisioning") {
      throw new UserError("Your workspace is still being created. Try again in a moment.");
    }
    await tx.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.id, ws.id));
    await tx
      .update(workspaceSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceSessions.workspaceId, ws.id), isNull(workspaceSessions.revokedAt)));
    await tx
      .update(user)
      .set(
        input.keepData
          ? { onboardedAt: null }
          : { onboardedAt: null, onboardingSelection: null },
      )
      .where(eq(user.id, actor.userId));
    if (!input.keepData) await clearAgentKeys(tx, actor.userId);
    await enqueueWorkspaceJob(tx, ws.id, { type: "delete_tenant", keepData: input.keepData });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "workspace.delete",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { slug: ws.slug, previousStatus: ws.status, keepData: input.keepData, self: true },
      ip: actor.ip,
    });
  });
}

