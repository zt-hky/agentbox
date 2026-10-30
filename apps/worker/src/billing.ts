import { eq } from "drizzle-orm";
import { BILLING_TIME_ZONE, planGate, type PlanGateResult } from "@agentbox/core";
import { creditBalances, plans, subscriptions } from "@agentbox/db/schema";
import type { Ctx } from "./types.ts";

export type StartGate =
  | { gate: PlanGateResult; memoryLimitMb: number; dailyRuntimeHours: number | null }
  | { gate: null; memoryLimitMb: 0; dailyRuntimeHours: null };

/** Whether the user's plan and credits allow waking a workspace right now (`gate: null`: no plan). */
export async function loadStartGate(ctx: Ctx, userId: string): Promise<StartGate> {
  const [row] = await ctx.db
    .select({
      plan: plans,
      sub: subscriptions,
      balance: creditBalances.balanceMicro,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .leftJoin(creditBalances, eq(creditBalances.userId, subscriptions.userId))
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (!row) return { gate: null, memoryLimitMb: 0, dailyRuntimeHours: null };
  const gate = planGate({
    plan: row.plan,
    subscription: row.sub,
    balanceMicro: row.balance ?? 0n,
    now: ctx.now(),
    timeZone: BILLING_TIME_ZONE,
  });
  return {
    gate,
    memoryLimitMb: row.plan.memoryLimitMb,
    dailyRuntimeHours: row.plan.dailyRuntimeHours,
  };
}

/** Plain-language reason a workspace cannot be woken, or null when it can. */
export function startBlockReason(start: StartGate): string | null {
  if (!start.gate) return "this account has no active plan";
  if (start.gate.canWake) return null;
  switch (start.gate.reason) {
    case "trial_ended":
      return "the free trial has ended";
    case "daily_limit":
      return "the daily runtime limit is reached";
    case "credits_exhausted":
    default:
      return "credits are exhausted";
  }
}
