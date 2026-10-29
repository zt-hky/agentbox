import { and, eq, sql } from "drizzle-orm";
import { encrypt, randomToken } from "@agentbox/core/tokens";
import {
  accessRequests,
  creditBalances,
  plans,
  subscriptions,
  user,
  workspaces,
} from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";
import { checkSlug } from "./slug";
import { addMonths } from "./time";

export interface GrantInput {
  userId: string;
  adminId: string;
  slug: string;
  planId: string;
  encryptionKey: string;
  ip: string | null;
  now?: Date;
}

export interface GrantResult {
  workspaceId: string;
  slot: number;
  userId: string;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } } | null)?.code;
  const causeCode = (e as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * Grant access to a user who has no workspace yet, in one transaction (plan step 9): whatever their
 * access status (pending, rejected, suspended before approval, never requested, or already active
 * like a bootstrap admin). A pending request is closed as approved; otherwise an approved request
 * row is recorded for history.
 */
export async function grantAccess(database: Db, input: GrantInput): Promise<GrantResult> {
  const now = input.now ?? new Date();
  try {
    return await database.transaction(async (tx) => {
      const target = (
        await tx.select().from(user).where(eq(user.id, input.userId)).for("update")
      )[0];
      if (!target) throw new UserError("User not found");

      const existing = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.userId, target.id))
        .limit(1);
      if (existing.length > 0) {
        throw new UserError("User already has a workspace; reactivate them instead");
      }

      const slugCheck = await checkSlug(input.slug, async (s) => {
        const r = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.slug, s))
          .limit(1);
        return r.length > 0;
      });
      if (!slugCheck.ok) throw new UserError(slugCheck.error);

      const plan = (await tx.select().from(plans).where(eq(plans.id, input.planId)).limit(1))[0];
      if (!plan || !plan.active) throw new UserError("Plan not found or inactive");

      const slotRes = await tx.execute<{ slot: number }>(
        sql`select nextval('tenant_slot_seq')::int as slot`,
      );
      const slot = slotRes.rows[0]?.slot;
      if (typeof slot !== "number") throw new UserError("No tenant slot available");

      const decided = { status: "approved" as const, decidedBy: input.adminId, decidedAt: now };
      const closed = await tx
        .update(accessRequests)
        .set(decided)
        .where(and(eq(accessRequests.userId, target.id), eq(accessRequests.status, "pending")))
        .returning({ id: accessRequests.id });
      if (closed.length === 0 && target.accessStatus !== "active") {
        await tx.insert(accessRequests).values({ userId: target.id, message: null, ...decided });
      }
      await tx.update(user).set({ accessStatus: "active" }).where(eq(user.id, target.id));

      const cycleEnd = addMonths(now, 1);
      await tx
        .insert(subscriptions)
        .values({ userId: target.id, planId: plan.id, cycleStart: now, cycleEnd })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: {
            planId: plan.id,
            cycleStart: now,
            cycleEnd,
            usedRuntimeHours: 0,
            usedCpuCoreHours: 0,
            usedMemGbHours: 0,
          },
        });
      await tx
        .insert(creditBalances)
        .values({ userId: target.id, balanceMicro: 0n })
        .onConflictDoNothing();

      const inserted = await tx
        .insert(workspaces)
        .values({
          userId: target.id,
          slug: input.slug,
          slot,
          status: "provisioning",
          identitySecretEnc: encrypt(randomToken(), input.encryptionKey),
        })
        .returning({ id: workspaces.id });
      const workspaceId = inserted[0]!.id;

      await enqueueWorkspaceJob(tx, workspaceId, { type: "provision_tenant" });
      await writeAudit(tx, {
        actorId: input.adminId,
        action: "access.approve",
        targetType: "user",
        targetId: target.id,
        metadata: {
          requestId: closed[0]?.id ?? null,
          previous: target.accessStatus,
          slug: input.slug,
          slot,
          planId: plan.id,
        },
        ip: input.ip,
      });
      return { workspaceId, slot, userId: target.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError("Slug or workspace already exists");
    throw e;
  }
}

/** Open a pending request for a newly signed-up user, so admins see them right away. */
export async function openAccessRequest(database: Db, userId: string): Promise<void> {
  await database.transaction(async (tx) => {
    const target = (await tx.select().from(user).where(eq(user.id, userId)).for("update"))[0];
    if (!target || target.accessStatus !== "none") return;
    await tx.insert(accessRequests).values({ userId, message: null });
    await tx.update(user).set({ accessStatus: "pending" }).where(eq(user.id, userId));
  });
}
