"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { db } from "@agentbox/db/client";
import { user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { enqueueWorkspaceJob } from "@/lib/jobs";

async function loadWorkspace(tx: Pick<typeof db, "select">, slug: string) {
  const rows = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, wsSlugSchema.parse(slug)))
    .limit(1);
  if (!rows[0]) throw new UserError("Workspace not found");
  return rows[0];
}

export async function adminStartWorkspace(slug: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const ws = await loadWorkspace(tx, slug);
      if (ws.status !== "sleeping" && ws.status !== "error") {
        throw new UserError(`Cannot start a workspace that is ${ws.status}`);
      }
      await enqueueWorkspaceJob(tx, ws.id, { type: "start_workspace" });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "workspace.start",
        targetType: "workspace",
        targetId: ws.id,
        metadata: { slug: ws.slug },
        ip,
      });
    });
    revalidatePath(`/admin/workspaces/${slug}`);
  });
}

export async function adminStopWorkspace(slug: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const ws = await loadWorkspace(tx, slug);
      if (ws.status !== "running" && ws.status !== "starting") {
        throw new UserError(`Cannot stop a workspace that is ${ws.status}`);
      }
      await enqueueWorkspaceJob(tx, ws.id, { type: "stop_workspace", reason: "admin" });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "workspace.stop",
        targetType: "workspace",
        targetId: ws.id,
        metadata: { slug: ws.slug },
        ip,
      });
    });
    revalidatePath(`/admin/workspaces/${slug}`);
  });
}

/** Typed-slug confirmed delete: web sets `deleting`, the worker finishes via `delete_tenant`. */
export async function adminDeleteWorkspace(slug: string, confirm: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const ws = await loadWorkspace(tx, slug);
      if (confirm !== ws.slug) throw new UserError("Type the workspace slug to confirm");
      if (ws.userId === admin.id) throw new UserError("You cannot delete your own workspace");
      if (ws.status === "deleting" || ws.status === "deleted")
        throw new UserError("Already deleted");
      await tx.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.id, ws.id));
      await tx.update(user).set({ accessStatus: "suspended" }).where(eq(user.id, ws.userId));
      await tx
        .update(workspaceSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(workspaceSessions.userId, ws.userId), isNull(workspaceSessions.revokedAt)));
      await enqueueWorkspaceJob(tx, ws.id, { type: "delete_tenant" });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "workspace.delete",
        targetType: "workspace",
        targetId: ws.id,
        metadata: { slug: ws.slug, userId: ws.userId, previousStatus: ws.status },
        ip,
      });
    });
    revalidatePath("/admin/workspaces");
    revalidatePath(`/admin/workspaces/${slug}`);
  });
}
