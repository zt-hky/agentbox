import { eq, sql } from "drizzle-orm";
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

export interface ApproveInput {
  requestId: string;
  adminId: string;
  slug: string;
  planId: string;
  encryptionKey: string;
  ip: string | null;
  now?: Date;
}

export interface ApproveResult {
  workspaceId: string;
  slot: number;
  userId: string;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } } | null)?.code;
  const causeCode = (e as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/** Approve an access request in one transaction (plan step 9). */
export async function approveAccessRequest(
  database: Db,
  input: ApproveInput,
): Promise<ApproveResult> {
  const now = input.now ?? new Date();
  try {
    return await database.transaction(async (tx) => {
      const reqRows = await tx
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, input.requestId))
        .for("update");
      const request = reqRows[0];
      if (!request) throw new UserError("Request not found");
      if (request.status !== "pending") throw new UserError("Request was already decided");

      const slugCheck = await checkSlug(input.slug, async (s) => {
        const r = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.slug, s))
          .limit(1);
        return r.length > 0;
      });
      if (!slugCheck.ok) throw new UserError(slugCheck.error);

      const planRows = await tx.select().from(plans).where(eq(plans.id, input.planId)).limit(1);
      const plan = planRows[0];
      if (!plan || !plan.active) throw new UserError("Plan not found or inactive");

      const existing = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.userId, request.userId))
        .limit(1);
      if (existing.length > 0) throw new UserError("User already has a workspace");

      const slotRes = await tx.execute<{ slot: number }>(
        sql`select nextval('tenant_slot_seq')::int as slot`,
      );
      const slot = slotRes.rows[0]?.slot;
      if (typeof slot !== "number") throw new UserError("No tenant slot available");

      await tx
        .update(accessRequests)
        .set({ status: "approved", decidedBy: input.adminId, decidedAt: now })
        .where(eq(accessRequests.id, request.id));
      await tx.update(user).set({ accessStatus: "active" }).where(eq(user.id, request.userId));

      const cycleEnd = addMonths(now, 1);
      await tx
        .insert(subscriptions)
        .values({ userId: request.userId, planId: plan.id, cycleStart: now, cycleEnd })
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
        .values({ userId: request.userId, balanceMicro: 0n })
        .onConflictDoNothing();

      const inserted = await tx
        .insert(workspaces)
        .values({
          userId: request.userId,
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
        targetId: request.userId,
        metadata: { requestId: request.id, slug: input.slug, slot, planId: plan.id },
        ip: input.ip,
      });
      return { workspaceId, slot, userId: request.userId };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError("Slug or workspace already exists");
    throw e;
  }
}
