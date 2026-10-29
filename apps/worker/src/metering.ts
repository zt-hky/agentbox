import { desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  BILLING_TIME_ZONE,
  computeCharge,
  evaluateActivity,
  localDateString,
  planGate,
  runtimeUsedToday,
  type IdleConfig,
} from "@agentbox/core";
import type { StatsResponse, WorkerHeartbeat } from "@agentbox/core/agent-api";
import { readSetting } from "@agentbox/db/client";
import {
  creditBalances,
  creditLedger,
  hostStats,
  jobs,
  plans,
  prices,
  subscriptions,
  usageSamples,
  workspaces,
} from "@agentbox/db/schema";
import { expireTrials } from "./cycle.ts";
import { errMessage } from "./log.ts";
import { addEvent, enqueueJob } from "./queue.ts";
import type { Ctx } from "./types.ts";

export const METERING_INTERVAL_MS = 60_000;
export const MAX_ELAPSED_SEC = 120;
const GIB = 2 ** 30;

export const DEFAULT_HIBERNATION: IdleConfig = {
  idleTimeoutMinutes: 30,
  idleCpuPercent: 5,
  idleNetBytesPerMin: 32768,
  maxAwakeHours: 24,
};

/** In-memory state: last seen oom_kill counters (first observation only sets the baseline). */
export interface MeteringState {
  oomKills: Map<string, number>;
}
export function createMeteringState(): MeteringState {
  return { oomKills: new Map() };
}

type WsStat = StatsResponse["workspaces"][number];

/** Worker liveness and queue depth, stored under `host_stats.payload.worker`. */
export async function workerHeartbeat(ctx: Ctx): Promise<WorkerHeartbeat> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      sql`${jobs.status} in ('queued','running') or (${jobs.status} = 'failed' and ${gte(jobs.finishedAt, new Date(now.getTime() - 24 * 3600_000))})`,
    )
    .groupBy(jobs.status);
  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return {
    heartbeatAt: now.toISOString(),
    queue: { queued: n("queued"), running: n("running"), failed24h: n("failed") },
  };
}

export async function meterTick(ctx: Ctx, state: MeteringState): Promise<void> {
  const { db } = ctx;
  const worker = await workerHeartbeat(ctx);
  let stats: StatsResponse;
  try {
    stats = await ctx.agent.stats();
  } catch (e) {
    // Keep the heartbeat fresh when only the agent is down; the stats age shows the outage.
    await db.execute(
      sql`update host_stats set payload = jsonb_set(payload, '{worker}', ${JSON.stringify(worker)}::jsonb) where id = 1`,
    );
    throw e;
  }
  const now = ctx.now();
  const payload = { ...stats, worker };
  await db
    .insert(hostStats)
    .values({ id: 1, payload, updatedAt: now })
    .onConflictDoUpdate({ target: hostStats.id, set: { payload, updatedAt: now } });

  const [priceRow] = await db
    .select()
    .from(prices)
    .where(lte(prices.effectiveFrom, now))
    .orderBy(desc(prices.effectiveFrom))
    .limit(1);
  if (!priceRow) ctx.log.warn("no effective prices row; usage is not charged");
  const price = {
    runtimePerHour: priceRow?.runtimePerHour ?? 0n,
    cpuCorePerHour: priceRow?.cpuCorePerHour ?? 0n,
    memGbPerHour: priceRow?.memGbPerHour ?? 0n,
  };
  const hibernation = (await readSetting(db, "hibernation")) ?? DEFAULT_HIBERNATION;

  const running = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.status, "running"));
  const byWs = new Map(stats.workspaces.map((w) => [w.ws, w]));
  for (const w of running) {
    try {
      await meterWorkspace(ctx, state, w.id, byWs.get(w.slug), price, hibernation);
    } catch (e) {
      ctx.log.error("metering failed for workspace", { ws: w.slug, error: errMessage(e) });
    }
  }
  // Trials end on the minute instead of waiting for the hourly cycle loop.
  await expireTrials(ctx);
}

async function meterWorkspace(
  ctx: Ctx,
  state: MeteringState,
  workspaceId: string,
  stat: WsStat | undefined,
  price: { runtimePerHour: bigint; cpuCorePerHour: bigint; memGbPerHour: bigint },
  hibernation: IdleConfig,
): Promise<void> {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [ws] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    if (!ws || ws.status !== "running") return;

    if (!stat || !stat.running) {
      await tx
        .update(workspaces)
        .set({ status: "error", awakeSince: null })
        .where(eq(workspaces.id, ws.id));
      await addEvent(tx, ws.id, "crashed", {});
      state.oomKills.delete(ws.slug);
      return;
    }

    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, ws.userId))
      .for("update");
    if (!sub) {
      ctx.log.error("running workspace has no subscription; skipping", { ws: ws.slug });
      return;
    }
    await tx.insert(creditBalances).values({ userId: ws.userId }).onConflictDoNothing();
    const [balanceRow] = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, ws.userId))
      .for("update");
    const [plan] = await tx.select().from(plans).where(eq(plans.id, sub.planId));
    if (!balanceRow || !plan) throw new Error("balance or plan row missing");

    const [lastSample] = await tx
      .select({ ts: usageSamples.ts })
      .from(usageSamples)
      .where(eq(usageSamples.workspaceId, ws.id))
      .orderBy(desc(usageSamples.ts))
      .limit(1);
    const prevMs = Math.max(lastSample?.ts.getTime() ?? 0, ws.awakeSince?.getTime() ?? 0);
    const sinceMs = prevMs > 0 ? now.getTime() - prevMs : METERING_INTERVAL_MS;
    const elapsed = Math.min(sinceMs / 1000, MAX_ELAPSED_SEC);

    const lastCpu = Number(ws.lastCpuUsec);
    const cpuDeltaUsec =
      stat.cpuUsageUsec - lastCpu < 0 ? stat.cpuUsageUsec : stat.cpuUsageUsec - lastCpu;
    const cpuCoreSec = cpuDeltaUsec / 1e6;
    const memGbSec = (stat.memoryCurrent / GIB) * elapsed;
    const cpuPercent = elapsed > 0 ? (cpuCoreSec / elapsed) * 100 : 0;
    const netBytesPerMin =
      elapsed > 0 ? ((stat.gatewayBytesDelta + stat.egressBytesDelta) / elapsed) * 60 : 0;
    ctx.log.debug("metering", { ws: ws.slug, cpuPercent, netBytesPerMin, elapsed });

    const usage = { runtimeSec: elapsed, cpuCoreSec, memGbSec };
    const allowanceRemaining = {
      runtimeHours: plan.allowanceRuntimeHours - sub.usedRuntimeHours,
      cpuCoreHours: plan.allowanceCpuCoreHours - sub.usedCpuCoreHours,
      memGbHours: plan.allowanceMemGbHours - sub.usedMemGbHours,
    };
    const computed = computeCharge(usage, price, allowanceRemaining);
    const { allowanceConsumed } = computed;
    // The free trial never spends credits: it stops when its allowance or daily cap is used up.
    const chargeMicro = plan.kind === "free" ? 0n : computed.chargeMicro;

    const newUsed = {
      usedRuntimeHours: sub.usedRuntimeHours + allowanceConsumed.runtimeHours,
      usedCpuCoreHours: sub.usedCpuCoreHours + allowanceConsumed.cpuCoreHours,
      usedMemGbHours: sub.usedMemGbHours + allowanceConsumed.memGbHours,
      // The daily counter counts all runtime on the local day and restarts when the day changes.
      dayStart: localDateString(now, BILLING_TIME_ZONE),
      usedTodayRuntimeHours:
        runtimeUsedToday(sub, now, BILLING_TIME_ZONE) + usage.runtimeSec / 3600,
    };
    await tx.update(subscriptions).set(newUsed).where(eq(subscriptions.id, sub.id));
    await tx.insert(usageSamples).values({
      workspaceId: ws.id,
      ts: now,
      runtimeSec: usage.runtimeSec,
      cpuCoreSec: usage.cpuCoreSec,
      memGbSec: usage.memGbSec,
      chargeMicro,
    });
    let balance = balanceRow.balanceMicro;
    if (chargeMicro > 0n) {
      balance -= chargeMicro;
      await tx.insert(creditLedger).values({
        userId: ws.userId,
        deltaMicro: -chargeMicro,
        reason: "usage",
        workspaceId: ws.id,
      });
      await tx
        .update(creditBalances)
        .set({ balanceMicro: balance })
        .where(eq(creditBalances.userId, ws.userId));
    }

    const prevOom = state.oomKills.get(ws.slug);
    state.oomKills.set(ws.slug, stat.oomKills);
    if (prevOom !== undefined && stat.oomKills > prevOom) {
      await addEvent(tx, ws.id, "oom", { oomKills: stat.oomKills, delta: stat.oomKills - prevOom });
    }

    const awakeSince = ws.awakeSince ?? now;
    const activity = evaluateActivity({
      now,
      lastActivityAt: ws.lastActivityAt ?? awakeSince,
      lastRequestAt: ws.lastRequestAt,
      cpuPercent,
      netBytesPerMin,
      awakeSince,
      config: {
        ...hibernation,
        idleTimeoutMinutes: plan.idleTimeoutMinutes ?? hibernation.idleTimeoutMinutes,
        maxAwakeHours: plan.maxAwakeHours ?? hibernation.maxAwakeHours,
      },
    });
    await tx
      .update(workspaces)
      .set({
        lastCpuUsec: BigInt(Math.trunc(stat.cpuUsageUsec)),
        ...(activity.active ? { lastActivityAt: now } : {}),
      })
      .where(eq(workspaces.id, ws.id));

    const gate = planGate({
      plan,
      subscription: { ...sub, ...newUsed },
      balanceMicro: balance,
      now,
      timeZone: BILLING_TIME_ZONE,
    });
    const reason = gate.reason ?? activity.stopReason;
    if (reason) {
      const queued = await enqueueJob(tx, {
        type: "stop_workspace",
        workspaceId: ws.id,
        payload: { reason },
      });
      if (queued) {
        if (reason === "credits_exhausted") {
          await addEvent(tx, ws.id, "credits_exhausted", { balanceMicro: balance.toString() });
        } else if (reason === "daily_limit") {
          await addEvent(tx, ws.id, "daily_limit", {
            usedTodayHours: newUsed.usedTodayRuntimeHours,
            resumesAt: gate.resumesAt?.toISOString() ?? null,
          });
        } else if (reason === "trial_ended") {
          await addEvent(tx, ws.id, "trial_ended", {
            trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
          });
        } else if (reason === "max_awake") {
          await addEvent(tx, ws.id, "max_awake", {});
        }
      }
    }
  });
}

export function startMeteringLoop(ctx: Ctx, state = createMeteringState()): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    meterTick(ctx, state)
      .catch((e) => ctx.log.error("metering tick failed", { error: errMessage(e) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(run, METERING_INTERVAL_MS);
      });
  };
  timer = setTimeout(run, METERING_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
