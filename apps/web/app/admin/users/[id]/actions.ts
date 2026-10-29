"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { plans, subscriptions, user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { adjustCredits } from "@/lib/credits";
import { UserError } from "@/lib/errors";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { creditAdjustSchema } from "@/lib/schemas";

const idSchema = z.string().min(1).max(128);

async function loadTarget(tx: Pick<typeof db, "select">, userId: string) {
  const rows = await tx
    .select()
    .from(user)
    .where(eq(user.id, idSchema.parse(userId)))
    .limit(1);
  const target = rows[0];
  if (!target) throw new UserError("User not found");
  return target;
}

export async function setUserRole(userId: string, role: "user" | "admin") {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const next = z.enum(["user", "admin"]).parse(role);
    if (userId === admin.id) throw new UserError("You cannot change your own role");
    await db.transaction(async (tx) => {
      const target = await loadTarget(tx, userId);
      await tx.update(user).set({ role: next }).where(eq(user.id, target.id));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "user.role_change",
        targetType: "user",
        targetId: target.id,
        metadata: { from: target.role, to: next },
        ip,
      });
    });
    revalidatePath(`/admin/users/${userId}`);
  });
}

export async function suspendUser(userId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    if (userId === admin.id) throw new UserError("You cannot suspend yourself");
    await db.transaction(async (tx) => {
      const target = await loadTarget(tx, userId);
      if (target.accessStatus === "suspended") throw new UserError("User is already suspended");
      await tx.update(user).set({ accessStatus: "suspended" }).where(eq(user.id, target.id));
      await tx
        .update(workspaceSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(workspaceSessions.userId, target.id), isNull(workspaceSessions.revokedAt)));
      const ws = (
        await tx.select().from(workspaces).where(eq(workspaces.userId, target.id)).limit(1)
      )[0];
      if (ws && (ws.status === "running" || ws.status === "starting")) {
        await enqueueWorkspaceJob(tx, ws.id, { type: "stop_workspace", reason: "suspended" });
      }
      await writeAudit(tx, {
        actorId: admin.id,
        action: "user.suspend",
        targetType: "user",
        targetId: target.id,
        metadata: { previous: target.accessStatus },
        ip,
      });
    });
    revalidatePath(`/admin/users/${userId}`);
  });
}

export async function reactivateUser(userId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const target = await loadTarget(tx, userId);
      if (target.accessStatus !== "suspended") throw new UserError("User is not suspended");
      const ws = (
        await tx.select().from(workspaces).where(eq(workspaces.userId, target.id)).limit(1)
      )[0];
      if (!ws || ws.status === "deleting" || ws.status === "deleted") {
        throw new UserError("This user's workspace was deleted; access cannot be restored");
      }
      await tx.update(user).set({ accessStatus: "active" }).where(eq(user.id, target.id));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "user.reactivate",
        targetType: "user",
        targetId: target.id,
        ip,
      });
    });
    revalidatePath(`/admin/users/${userId}`);
  });
}

export async function changeUserPlan(userId: string, planId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const newPlanId = z.uuid().parse(planId);
    await db.transaction(async (tx) => {
      const target = await loadTarget(tx, userId);
      const plan = (await tx.select().from(plans).where(eq(plans.id, newPlanId)).limit(1))[0];
      if (!plan || !plan.active) throw new UserError("Plan not found or inactive");
      const sub = (
        await tx.select().from(subscriptions).where(eq(subscriptions.userId, target.id)).limit(1)
      )[0];
      if (!sub) throw new UserError("User has no subscription");
      await tx.update(subscriptions).set({ planId: plan.id }).where(eq(subscriptions.id, sub.id));
      const ws = (
        await tx.select().from(workspaces).where(eq(workspaces.userId, target.id)).limit(1)
      )[0];
      if (ws && ws.status !== "deleting" && ws.status !== "deleted") {
        await enqueueWorkspaceJob(tx, ws.id, { type: "update_limits" });
      }
      await writeAudit(tx, {
        actorId: admin.id,
        action: "user.plan_change",
        targetType: "user",
        targetId: target.id,
        metadata: { from: sub.planId, to: plan.id },
        ip,
      });
    });
    revalidatePath(`/admin/users/${userId}`);
  });
}

export async function adjustUserCredits(input: z.input<typeof creditAdjustSchema>) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = creditAdjustSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    await loadTarget(db, parsed.data.userId);
    const res = await adjustCredits(db, { ...parsed.data, actorId: admin.id, ip });
    revalidatePath(`/admin/users/${parsed.data.userId}`);
    return { balanceMicro: res.balanceMicro.toString() };
  });
}
