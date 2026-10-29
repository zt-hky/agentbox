import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { CREDITS_ONLY_PLAN_ID } from "@agentbox/core";
import {
  auditLog,
  creditBalances,
  creditLedger,
  plans,
  subscriptions,
  workspaces,
} from "@agentbox/db/schema";
import { errMessage } from "./log.ts";
import { addEvent, enqueueJob } from "./queue.ts";
import type { Ctx } from "./types.ts";

export const CYCLE_INTERVAL_MS = 3_600_000;
const MAX_CATCH_UP = 24;

/** One calendar month later (UTC), clamping the day (Jan 31 -> Feb 28/29). */
export function addMonth(d: Date): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + 1);
  const dim = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, dim));
  return out;
}

/**
 * Free trials whose `trialEndsAt` has passed: stop a running workspace (`trial_ended`) and switch the
 * subscription to the internal "Credits only" plan. Files are kept. Returns the number switched.
 */
export async function expireTrials(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(
      and(
        eq(plans.kind, "free"),
        isNotNull(subscriptions.trialEndsAt),
        lte(subscriptions.trialEndsAt, ctx.now()),
      ),
    );
  let switched = 0;
  for (const { id } of due) {
    try {
      if (await expireOneTrial(ctx, id)) switched++;
    } catch (e) {
      ctx.log.error("trial expiry failed", { subscription: id, error: errMessage(e) });
    }
  }
  return switched;
}

async function expireOneTrial(ctx: Ctx, subscriptionId: string): Promise<boolean> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .for("update");
    if (!sub?.trialEndsAt || sub.trialEndsAt.getTime() > now.getTime()) return false;
    const [plan] = await tx.select().from(plans).where(eq(plans.id, sub.planId));
    if (plan?.kind !== "free") return false;

    await tx
      .update(subscriptions)
      .set({
        planId: CREDITS_ONLY_PLAN_ID,
        cycleStart: now,
        cycleEnd: addMonth(now),
        usedRuntimeHours: 0,
        usedCpuCoreHours: 0,
        usedMemGbHours: 0,
        dayStart: null,
        usedTodayRuntimeHours: 0,
      })
      .where(eq(subscriptions.id, sub.id));
    await tx.insert(auditLog).values({
      actorId: null,
      action: "subscription.trial_ended",
      targetType: "subscription",
      targetId: sub.id,
      metadata: {
        userId: sub.userId,
        fromPlanId: plan.id,
        toPlanId: CREDITS_ONLY_PLAN_ID,
        trialEndsAt: sub.trialEndsAt.toISOString(),
      },
    });
    const [ws] = await tx
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(and(eq(workspaces.userId, sub.userId), ne(workspaces.status, "deleted")));
    if (ws) {
      await enqueueJob(tx, { type: "update_limits", workspaceId: ws.id, payload: {} });
      if (ws.status === "running") {
        const queued = await enqueueJob(tx, {
          type: "stop_workspace",
          workspaceId: ws.id,
          payload: { reason: "trial_ended" },
        });
        if (queued) {
          await addEvent(tx, ws.id, "trial_ended", { trialEndsAt: sub.trialEndsAt.toISOString() });
        }
      }
    }
    return true;
  });
}

/** Roll every subscription whose cycle has ended. Returns the number of cycles advanced. */
export async function cycleTick(ctx: Ctx): Promise<number> {
  let advanced = 0;
  await expireTrials(ctx);
  const due = await ctx.db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(lte(subscriptions.cycleEnd, ctx.now()));
  for (const { id } of due) {
    try {
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        if (!(await advanceOne(ctx, id))) break;
        advanced++;
      }
    } catch (e) {
      ctx.log.error("cycle advance failed", { subscription: id, error: errMessage(e) });
    }
  }
  return advanced;
}

async function advanceOne(ctx: Ctx, subscriptionId: string): Promise<boolean> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .for("update");
    if (!sub || sub.cycleEnd.getTime() > now.getTime()) return false;
    const [plan] = await tx.select().from(plans).where(eq(plans.id, sub.planId));
    if (!plan) throw new Error(`plan ${sub.planId} missing`);

    const reset = {
      cycleStart: sub.cycleEnd,
      cycleEnd: addMonth(sub.cycleEnd),
      usedRuntimeHours: 0,
      usedCpuCoreHours: 0,
      usedMemGbHours: 0,
    };

    if (plan.kind === "package" && plan.monthlyPriceMicro > 0n) {
      await tx.insert(creditBalances).values({ userId: sub.userId }).onConflictDoNothing();
      const [bal] = await tx
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.userId, sub.userId))
        .for("update");
      const balance = bal?.balanceMicro ?? 0n;
      if (balance >= plan.monthlyPriceMicro) {
        await tx
          .update(creditBalances)
          .set({ balanceMicro: balance - plan.monthlyPriceMicro })
          .where(eq(creditBalances.userId, sub.userId));
        await tx.insert(creditLedger).values({
          userId: sub.userId,
          deltaMicro: -plan.monthlyPriceMicro,
          reason: "package_fee",
          note: plan.name,
        });
        await tx.update(subscriptions).set(reset).where(eq(subscriptions.id, sub.id));
      } else {
        // Not back to Free: the trial was already used.
        await tx
          .update(subscriptions)
          .set({ ...reset, planId: CREDITS_ONLY_PLAN_ID })
          .where(eq(subscriptions.id, sub.id));
        await tx.insert(auditLog).values({
          actorId: null,
          action: "subscription.downgraded_insufficient_credits",
          targetType: "subscription",
          targetId: sub.id,
          metadata: {
            userId: sub.userId,
            fromPlanId: plan.id,
            toPlanId: CREDITS_ONLY_PLAN_ID,
            monthlyPriceMicro: plan.monthlyPriceMicro.toString(),
            balanceMicro: balance.toString(),
          },
        });
        const [ws] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.userId, sub.userId), ne(workspaces.status, "deleted")));
        if (ws) await enqueueJob(tx, { type: "update_limits", workspaceId: ws.id, payload: {} });
      }
    } else {
      await tx.update(subscriptions).set(reset).where(eq(subscriptions.id, sub.id));
    }
    return true;
  });
}

export function startCycleLoop(ctx: Ctx): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    cycleTick(ctx)
      .catch((e) => ctx.log.error("cycle tick failed", { error: errMessage(e) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(run, CYCLE_INTERVAL_MS);
      });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
