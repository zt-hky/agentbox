import { eq } from "drizzle-orm";
import { readSetting } from "@agentbox/db/client";
import {
  creditBalances,
  creditLedger,
  plans,
  subscriptions,
  user,
  workspaces,
} from "@agentbox/db/schema";
import { trialEnd } from "./approve";
import { writeAudit } from "./audit";
import type { Db } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";
import { formatCredits } from "./money";
import { addMonths } from "./time";

export interface ChangePlanInput {
  userId: string;
  planId: string;
  /** Package plans only: debit the first month now, or start the cycle without a fee. */
  fee: "charge" | "waive";
  adminId: string;
  ip: string | null;
  now?: Date;
}

export interface ChangePlanResult {
  chargedMicro: bigint;
  waivedMicro: bigint;
  balanceMicro: bigint;
}

/**
 * Move a user to another plan in one transaction and start a fresh cycle (usage counters reset).
 * A package plan with a price charges its first month from the credit balance (ledger
 * `package_fee`) unless the admin waives it; an insufficient balance refuses the change. The
 * trial end is set only for plans with `trialDays`. Queues `update_limits`; running containers
 * keep their old CPU/RAM until restart.
 */
export async function changeUserPlanTx(
  database: Db,
  input: ChangePlanInput,
): Promise<ChangePlanResult> {
  const now = input.now ?? new Date();
  return database.transaction(async (tx) => {
    const target = (await tx.select().from(user).where(eq(user.id, input.userId)).limit(1))[0];
    if (!target) throw new UserError("User not found");
    const plan = (await tx.select().from(plans).where(eq(plans.id, input.planId)).limit(1))[0];
    if (!plan || !plan.active) throw new UserError("Plan not found or inactive");
    const sub = (
      await tx.select().from(subscriptions).where(eq(subscriptions.userId, target.id)).for("update")
    )[0];
    if (!sub) throw new UserError("User has no subscription");
    if (sub.planId === plan.id) throw new UserError("The user is already on this plan");

    await tx.insert(creditBalances).values({ userId: target.id }).onConflictDoNothing();
    const balance =
      (
        await tx
          .select({ b: creditBalances.balanceMicro })
          .from(creditBalances)
          .where(eq(creditBalances.userId, target.id))
          .for("update")
      )[0]?.b ?? 0n;

    const fee = plan.kind === "package" ? plan.monthlyPriceMicro : 0n;
    const charge = input.fee === "charge" ? fee : 0n;
    const waived = input.fee === "waive" ? fee : 0n;
    let balanceAfter = balance;
    if (charge > 0n) {
      if (balance < charge) {
        const billing = await readSetting(tx, "billing");
        const label = billing?.creditLabel ?? "credit";
        const vnd = billing?.creditValueVnd ?? 1000;
        throw new UserError(
          `Insufficient credits: balance ${formatCredits(balance, label, vnd)}, first month of ${plan.name} costs ${formatCredits(charge, label, vnd)}. Top up first or waive this month's fee.`,
        );
      }
      balanceAfter = balance - charge;
      await tx
        .update(creditBalances)
        .set({ balanceMicro: balanceAfter })
        .where(eq(creditBalances.userId, target.id));
      await tx.insert(creditLedger).values({
        userId: target.id,
        deltaMicro: -charge,
        reason: "package_fee",
        note: `${plan.name}: first month`,
        actorId: input.adminId,
      });
    }

    const trialEndsAt = trialEnd(plan, now);
    await tx
      .update(subscriptions)
      .set({
        planId: plan.id,
        cycleStart: now,
        cycleEnd: addMonths(now, 1),
        usedRuntimeHours: 0,
        usedCpuCoreHours: 0,
        usedMemGbHours: 0,
        trialEndsAt,
        dayStart: null,
        usedTodayRuntimeHours: 0,
      })
      .where(eq(subscriptions.id, sub.id));

    const ws = (
      await tx.select().from(workspaces).where(eq(workspaces.userId, target.id)).limit(1)
    )[0];
    if (ws && ws.status !== "deleting" && ws.status !== "deleted") {
      await enqueueWorkspaceJob(tx, ws.id, { type: "update_limits" });
    }
    await writeAudit(tx, {
      actorId: input.adminId,
      action: "user.plan_change",
      targetType: "user",
      targetId: target.id,
      metadata: {
        from: sub.planId,
        to: plan.id,
        chargedMicro: charge.toString(),
        waivedMicro: waived.toString(),
        waived: waived > 0n,
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
      },
      ip: input.ip,
    });
    return { chargedMicro: charge, waivedMicro: waived, balanceMicro: balanceAfter };
  });
}
