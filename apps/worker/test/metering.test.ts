import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StatsResponse } from "@agentbox/core/agent-api";
import {
  creditBalances,
  creditLedger,
  hostStats,
  jobs,
  plans,
  prices,
  subscriptions,
  usageSamples,
  workspaceEvents,
  workspaces,
} from "@agentbox/db/schema";
import { createMeteringState, meterTick } from "../src/metering.ts";
import { CREDITS_ONLY_PLAN_ID } from "@agentbox/core";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { seedWorld, type World } from "./helpers/seed.ts";

let t: TestDb;
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000); // after the seeded prices row
const clock = createClock(T0);
let stats: StatsResponse;

const wsStat = (over: Partial<StatsResponse["workspaces"][number]> = {}) => ({
  ws: "alice",
  cpuUsageUsec: 0,
  memoryCurrent: 0,
  oomKills: 0,
  pidsCurrent: 1,
  gatewayBytesDelta: 0,
  egressBytesDelta: 0,
  running: true,
  startedAt: null,
  ...over,
});

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  clock.set(T0);
  await resetDb(t.db);
  stats = {
    host: {
      cpus: 16,
      memTotalBytes: 32 * 2 ** 30,
      memAvailableBytes: 16 * 2 ** 30,
      diskTotalBytes: 1e12,
      diskFreeBytes: 5e11,
      loadavg: [0, 0, 0],
      uptimeSec: 1,
      kernel: "k",
      podmanVersion: "5.7.0",
      services: [],
      firewall: { blockedPackets: 0, smtpPackets: 0, ipv6Packets: 0 },
      publicIpBlocked: null,
    },
    tenants: [],
    workspaces: [wsStat()],
  };
});

const ctx = () => makeCtx(t.db, clock, { agent: { stats: async () => stats } });
const sleepAfter = (ms: number) => new Date(clock.now().getTime() - ms);

async function tinyPlan(over: Partial<typeof plans.$inferInsert> = {}) {
  const [p] = await t.db
    .insert(plans)
    .values({
      name: `tiny-${Math.random()}`,
      kind: "payg",
      cpuLimit: "2.00",
      memoryLimitMb: 1024,
      diskLimitGb: 5,
      allowanceRuntimeHours: 0.01, // 36 s
      allowanceCpuCoreHours: 0.005, // 18 core-s
      allowanceMemGbHours: 1,
      ...over,
    })
    .returning();
  return p!;
}
const sub = async (w: World) =>
  (await t.db.select().from(subscriptions).where(eq(subscriptions.id, w.subscriptionId)))[0]!;
const ws = async (w: World) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, w.workspaceId)))[0]!;
const events = async (w: World) =>
  (
    await t.db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, w.workspaceId))
  ).map((e) => e.type);
const stopJobs = () => t.db.select().from(jobs).where(eq(jobs.type, "stop_workspace"));
const balance = async (w: World) =>
  (await t.db.select().from(creditBalances).where(eq(creditBalances.userId, w.userId)))[0]!
    .balanceMicro;

describe("metering transaction", () => {
  it("consumes allowance first, then charges overflow with ledger row and balance decrement", async () => {
    const plan = await tinyPlan();
    const w = await seedWorld(t.db, {
      planId: plan.id,
      balance: 1_000_000n,
      workspace: { awakeSince: sleepAfter(60_000), lastActivityAt: sleepAfter(60_000) },
    });
    // elapsed 60 s: runtime 60 s (allow 36 s), cpu 36 core-s (allow 18), mem 1 GiB*60 s (allow 1 GB-h)
    stats.workspaces = [wsStat({ cpuUsageUsec: 36_000_000, memoryCurrent: 2 ** 30 })];
    await meterTick(ctx(), createMeteringState());

    // runtime overflow 24 s = 0.006667 h * 600000 = 4000; cpu overflow 18 s = 0.005 h * 400000 = 2000
    const [sample] = await t.db.select().from(usageSamples);
    expect(sample).toMatchObject({
      runtimeSec: 60,
      cpuCoreSec: 36,
      memGbSec: 60,
      chargeMicro: 6000n,
    });
    expect(sample!.ts.getTime()).toBe(clock.now().getTime());
    const [led] = await t.db.select().from(creditLedger);
    expect(led).toMatchObject({
      deltaMicro: -6000n,
      reason: "usage",
      workspaceId: w.workspaceId,
      userId: w.userId,
    });
    expect(await balance(w)).toBe(1_000_000n - 6000n);
    const s = await sub(w);
    expect(s.usedRuntimeHours).toBeCloseTo(0.01, 12);
    expect(s.usedCpuCoreHours).toBeCloseTo(0.005, 12);
    expect(s.usedMemGbHours).toBeCloseTo(60 / 3600, 12);
    const row = await ws(w);
    expect(row.lastCpuUsec).toBe(36_000_000n);
    expect(row.lastActivityAt!.getTime()).toBe(clock.now().getTime()); // 60 % cpu → active
    expect(await stopJobs()).toHaveLength(0);
  });

  it("stays within allowance without a ledger row when usage is small", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 10,
      allowanceCpuCoreHours: 10,
      allowanceMemGbHours: 10,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: { awakeSince: sleepAfter(60_000) },
    });
    await meterTick(ctx(), createMeteringState());
    expect(await t.db.select().from(creditLedger)).toHaveLength(0);
    expect((await sub(w)).usedRuntimeHours).toBeCloseTo(60 / 3600, 12);
    expect(await balance(w)).toBe(0n);
  });

  it("caps elapsed at 120 s and uses the previous sample time as the start", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 10,
      allowanceCpuCoreHours: 10,
      allowanceMemGbHours: 10,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: { awakeSince: sleepAfter(3600_000) },
    });
    await meterTick(ctx(), createMeteringState());
    clock.advance(45_000);
    await meterTick(ctx(), createMeteringState());
    const samples = (
      await t.db.select().from(usageSamples).where(eq(usageSamples.workspaceId, w.workspaceId))
    ).sort((a, b) => a.ts.getTime() - b.ts.getTime());
    expect(samples.map((s) => s.runtimeSec)).toEqual([120, 45]);
  });

  it("uses the absolute counter when the cpu delta is negative (container restarted)", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 10,
      allowanceCpuCoreHours: 10,
      allowanceMemGbHours: 10,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: { awakeSince: sleepAfter(60_000), lastCpuUsec: 500_000_000n },
    });
    stats.workspaces = [wsStat({ cpuUsageUsec: 6_000_000 })];
    await meterTick(ctx(), createMeteringState());
    const [sample] = await t.db.select().from(usageSamples);
    expect(sample!.cpuCoreSec).toBe(6);
    expect((await ws(w)).lastCpuUsec).toBe(6_000_000n);
  });

  it("detects a crash: event, status error, no billing; missing from stats counts too", async () => {
    const w = await seedWorld(t.db, { workspace: { awakeSince: sleepAfter(60_000) } });
    stats.workspaces = [wsStat({ running: false })];
    await meterTick(ctx(), createMeteringState());
    expect(await events(w)).toEqual(["crashed"]);
    expect(await ws(w)).toMatchObject({ status: "error", awakeSince: null });
    expect(await t.db.select().from(usageSamples)).toHaveLength(0);

    await t.db.update(workspaces).set({ status: "running", awakeSince: sleepAfter(1000) });
    stats.workspaces = [];
    await meterTick(ctx(), createMeteringState());
    expect((await events(w)).filter((e) => e === "crashed")).toHaveLength(2);
    expect((await ws(w)).status).toBe("error");
  });

  it("enqueues one idle stop when nothing is active, and not again while it is queued", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 10,
      allowanceCpuCoreHours: 10,
      allowanceMemGbHours: 10,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: {
        awakeSince: sleepAfter(3600_000),
        lastActivityAt: sleepAfter(31 * 60_000),
        lastRequestAt: sleepAfter(31 * 60_000),
      },
    });
    await meterTick(ctx(), createMeteringState());
    await meterTick(ctx(), createMeteringState());
    const rows = await stopJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: w.workspaceId, payload: { reason: "idle" } });
  });

  it("recent requests or network traffic keep the workspace awake and refresh lastActivityAt", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 10,
      allowanceCpuCoreHours: 10,
      allowanceMemGbHours: 10,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: {
        awakeSince: sleepAfter(3600_000),
        lastActivityAt: sleepAfter(31 * 60_000),
        lastRequestAt: sleepAfter(60_000),
      },
    });
    await meterTick(ctx(), createMeteringState());
    expect(await stopJobs()).toHaveLength(0);
    expect((await ws(w)).lastActivityAt!.getTime()).toBe(clock.now().getTime());

    clock.advance(60_000);
    await t.db
      .update(workspaces)
      .set({ lastActivityAt: sleepAfter(31 * 60_000), lastRequestAt: null });
    stats.workspaces = [wsStat({ gatewayBytesDelta: 100_000 })]; // 100000 B / 60 s * 60 = 100000 B/min >= 32768
    await meterTick(ctx(), createMeteringState());
    expect(await stopJobs()).toHaveLength(0);
  });

  it("enqueues max_awake stop with an event", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 100,
      allowanceCpuCoreHours: 100,
      allowanceMemGbHours: 100,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: { awakeSince: sleepAfter(25 * 3600_000), lastRequestAt: sleepAfter(1000) },
    });
    await meterTick(ctx(), createMeteringState());
    expect((await stopJobs())[0]).toMatchObject({ payload: { reason: "max_awake" } });
    expect(await events(w)).toEqual(["max_awake"]);
  });

  it("stops with credits_exhausted when the post-charge balance and allowance are gone, once", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 0,
      allowanceCpuCoreHours: 0,
      allowanceMemGbHours: 0,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      balance: 100n,
      workspace: { awakeSince: sleepAfter(60_000), lastRequestAt: sleepAfter(1000) },
    });
    await meterTick(ctx(), createMeteringState());
    // 60 s runtime at 600000/h = 10000 µ > 100 → balance goes negative
    expect(await balance(w)).toBe(100n - 10_000n);
    expect((await stopJobs())[0]).toMatchObject({ payload: { reason: "credits_exhausted" } });
    expect(await events(w)).toEqual(["credits_exhausted"]);
    clock.advance(60_000);
    await meterTick(ctx(), createMeteringState());
    expect(await stopJobs()).toHaveLength(1);
    expect(await events(w)).toEqual(["credits_exhausted"]);
  });

  it("records an oom event only when the kill counter increases after the first observation", async () => {
    const plan = await tinyPlan({
      allowanceRuntimeHours: 100,
      allowanceCpuCoreHours: 100,
      allowanceMemGbHours: 100,
    });
    const w = await seedWorld(t.db, {
      planId: plan.id,
      workspace: { awakeSince: sleepAfter(60_000), lastRequestAt: sleepAfter(1000) },
    });
    const state = createMeteringState();
    stats.workspaces = [wsStat({ oomKills: 3 })];
    await meterTick(ctx(), state);
    expect(await events(w)).toEqual([]);
    clock.advance(60_000);
    stats.workspaces = [wsStat({ oomKills: 5 })];
    await meterTick(ctx(), state);
    expect(await events(w)).toEqual(["oom"]);
    clock.advance(60_000);
    await meterTick(ctx(), state);
    expect(await events(w)).toEqual(["oom"]);
  });

  it("upserts host_stats with the agent payload", async () => {
    await meterTick(ctx(), createMeteringState());
    stats.host.memTotalBytes = 123;
    await meterTick(ctx(), createMeteringState());
    const rows = await t.db.select().from(hostStats);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as StatsResponse).host.memTotalBytes).toBe(123);
  });

  it("writes the worker heartbeat with queue counts into the payload", async () => {
    const row = (status: "queued" | "running" | "failed", finishedAt: Date | null) => ({
      type: "sync_git" as const,
      workspaceId: null,
      status,
      finishedAt,
    });
    const day = 24 * 3600_000;
    await t.db
      .insert(jobs)
      .values([
        row("queued", null),
        row("queued", null),
        row("running", null),
        row("failed", new Date(clock.now().getTime() - day + 1000)),
        row("failed", new Date(clock.now().getTime() - day - 1000)),
      ]);
    await meterTick(ctx(), createMeteringState());
    const [r] = await t.db.select().from(hostStats);
    expect((r!.payload as { worker: unknown }).worker).toEqual({
      heartbeatAt: clock.now().toISOString(),
      queue: { queued: 2, running: 1, failed24h: 1 },
    });
  });

  it("refreshes only the heartbeat when the agent is unreachable", async () => {
    await meterTick(ctx(), createMeteringState());
    clock.advance(60_000);
    const broken = makeCtx(t.db, clock, {
      agent: {
        stats: async () => {
          throw new Error("agent down");
        },
      },
    });
    await expect(meterTick(broken, createMeteringState())).rejects.toThrow("agent down");
    const [r] = await t.db.select().from(hostStats);
    const p = r!.payload as StatsResponse & { worker: { heartbeatAt: string } };
    expect(p.worker.heartbeatAt).toBe(clock.now().toISOString());
    expect(p.host.cpus).toBe(16);
  });

  it("ignores workspaces that are not running", async () => {
    await seedWorld(t.db, { status: "sleeping" });
    await meterTick(ctx(), createMeteringState());
    expect(await t.db.select().from(usageSamples)).toHaveLength(0);
  });
});

describe("plans v2 metering", () => {
  const MAX_ID = "00000000-0000-4000-8000-0000000000a4";
  // 2026-03-10T12:00Z is 19:00 on 2026-03-10 in UTC+7.
  const DAY = "2026-03-10";
  const base = new Date("2026-03-10T12:00:00.000Z");
  const awake = {
    awakeSince: new Date(base.getTime() - 60_000),
    lastRequestAt: new Date(base.getTime() - 1000),
  };
  // Migration 0005's price row is effective "now"; pin the same rates before the fixed test clock.
  beforeAll(async () => {
    await t.db
      .insert(prices)
      .values({
        runtimePerHour: 600_000n,
        cpuCorePerHour: 400_000n,
        memGbPerHour: 150_000n,
        effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      })
      .onConflictDoNothing();
  });
  const meter = async () => {
    clock.set(base);
    await meterTick(ctx(), createMeteringState());
  };

  it("counts every runtime second towards today's counter and sets the local day", async () => {
    const w = await seedWorld(t.db, { workspace: awake });
    await meter();
    const s = await sub(w);
    expect(s.dayStart).toBe(DAY);
    expect(s.usedTodayRuntimeHours).toBeCloseTo(60 / 3600, 12);
    clock.advance(60_000);
    await meterTick(ctx(), createMeteringState());
    expect((await sub(w)).usedTodayRuntimeHours).toBeCloseTo(120 / 3600, 12);
  });

  it("the counter restarts when the local day changes (UTC+7 midnight), not at UTC midnight", async () => {
    const w = await seedWorld(t.db, {
      workspace: awake,
      subscription: { dayStart: "2026-03-09", usedTodayRuntimeHours: 5 },
    });
    await meter();
    const s = await sub(w);
    expect(s.dayStart).toBe(DAY);
    expect(s.usedTodayRuntimeHours).toBeCloseTo(60 / 3600, 12);

    // Same instant 17:00Z-1s is still the 10th: counter keeps adding.
    clock.set(new Date("2026-03-10T16:59:00.000Z"));
    await t.db.update(workspaces).set({ awakeSince: new Date("2026-03-10T16:58:00.000Z") });
    await t.db.delete(usageSamples);
    await meterTick(ctx(), createMeteringState());
    expect((await sub(w)).usedTodayRuntimeHours).toBeCloseTo(120 / 3600, 12);
    // 17:00Z is 00:00 on the 11th: reset to just this sample.
    clock.set(new Date("2026-03-10T17:00:00.000Z"));
    await meterTick(ctx(), createMeteringState());
    const s2 = await sub(w);
    expect(s2.dayStart).toBe("2026-03-11");
    expect(s2.usedTodayRuntimeHours).toBeCloseTo(60 / 3600, 12);
  });

  it("free trial hits the 6 h daily cap exactly: stops with daily_limit + event, no credit charge", async () => {
    const w = await seedWorld(t.db, {
      balance: 5_000_000n,
      workspace: awake,
      // 5 h 59 min used: this 60 s sample reaches exactly 6 h.
      subscription: { dayStart: DAY, usedTodayRuntimeHours: 6 - 60 / 3600 },
    });
    await meter();
    expect((await sub(w)).usedTodayRuntimeHours).toBeCloseTo(6, 12);
    const [job] = await stopJobs();
    expect(job).toMatchObject({ workspaceId: w.workspaceId, payload: { reason: "daily_limit" } });
    expect(await events(w)).toEqual(["daily_limit"]);
    const [e] = await t.db.select().from(workspaceEvents);
    expect(e!.details).toMatchObject({ resumesAt: "2026-03-10T17:00:00.000Z" });
    expect(await balance(w)).toBe(5_000_000n); // free trial never spends credits
    expect(await t.db.select().from(creditLedger)).toHaveLength(0);
  });

  it("free trial below the cap keeps running", async () => {
    const w = await seedWorld(t.db, {
      workspace: awake,
      subscription: { dayStart: DAY, usedTodayRuntimeHours: 5.9 },
    });
    await meter();
    expect(await stopJobs()).toHaveLength(0);
    expect(await events(w)).toEqual([]);
  });

  it("trial end while running stops with trial_ended + event", async () => {
    const w = await seedWorld(t.db, {
      workspace: awake,
      subscription: { trialEndsAt: new Date(base.getTime() - 1) },
    });
    await meter();
    // meterTick also expires the trial; the stop was queued once.
    const jobsRows = await stopJobs();
    expect(jobsRows).toHaveLength(1);
    expect(jobsRows[0]).toMatchObject({ payload: { reason: "trial_ended" } });
    expect(await events(w)).toEqual(["trial_ended"]);
    expect((await sub(w)).planId).toBe(CREDITS_ONLY_PLAN_ID);
  });

  it("free trial: exhausted included runtime stops with credits_exhausted despite a balance", async () => {
    const w = await seedWorld(t.db, {
      balance: 9_000_000n,
      workspace: awake,
      subscription: { usedRuntimeHours: 30 - 60 / 3600, dayStart: DAY },
    });
    await meter();
    expect((await stopJobs())[0]).toMatchObject({ payload: { reason: "credits_exhausted" } });
    expect(await events(w)).toEqual(["credits_exhausted"]);
    expect(await balance(w)).toBe(9_000_000n);
  });

  it("Credits only is billed at credit rates and stops at balance 0", async () => {
    const w = await seedWorld(t.db, {
      planId: CREDITS_ONLY_PLAN_ID,
      balance: 5_000n,
      workspace: awake,
    });
    await meter();
    // 60 s runtime at 0.6 credit/h = 10000 µcredit > 5000 balance
    expect(await balance(w)).toBe(-5_000n);
    expect((await stopJobs())[0]).toMatchObject({ payload: { reason: "credits_exhausted" } });
  });

  it("package overflow beyond included runtime is charged in credits at the new rates", async () => {
    await seedWorld(t.db, {
      plan: "Pro",
      balance: 50_000_000n,
      workspace: awake,
      subscription: { usedRuntimeHours: 200, usedCpuCoreHours: 400, usedMemGbHours: 800 },
    });
    stats.workspaces = [wsStat({ cpuUsageUsec: 60_000_000, memoryCurrent: 2 * 2 ** 30 })];
    await meter();
    // runtime 60 s*0.6/h = 10000; cpu 60 core-s*0.4/h = 6667; mem 2 GiB*60 s*0.15/h = 5000
    const [sample] = await t.db.select().from(usageSamples);
    expect(sample!.chargeMicro).toBe(10_000n + 6_667n + 5_000n);
    expect(await stopJobs()).toHaveLength(0);
  });

  describe("per-plan idle / max-awake overrides", () => {
    it("plan idleTimeoutMinutes overrides the global 30 min", async () => {
      // Free trial: 15 min idle. 20 min idle -> stops (global 30 would not).
      const w = await seedWorld(t.db, {
        workspace: {
          awakeSince: new Date(base.getTime() - 3600_000),
          lastActivityAt: new Date(base.getTime() - 20 * 60_000),
          lastRequestAt: new Date(base.getTime() - 20 * 60_000),
        },
      });
      await meter();
      expect((await stopJobs())[0]).toMatchObject({
        workspaceId: w.workspaceId,
        payload: { reason: "idle" },
      });
    });

    it("Max (60 min idle) is not stopped after 40 idle minutes", async () => {
      await seedWorld(t.db, {
        planId: MAX_ID,
        balance: 5_000_000n,
        workspace: {
          awakeSince: new Date(base.getTime() - 3600_000),
          lastActivityAt: new Date(base.getTime() - 40 * 60_000),
          lastRequestAt: new Date(base.getTime() - 40 * 60_000),
        },
      });
      await meter();
      expect(await stopJobs()).toHaveLength(0);
    });

    it("plan maxAwakeHours overrides the global 24 h; null falls back to the global", async () => {
      const w = await seedWorld(t.db, {
        plan: "Pro", // 12 h
        balance: 5_000_000n,
        workspace: {
          awakeSince: new Date(base.getTime() - 13 * 3600_000),
          lastRequestAt: new Date(base.getTime() - 1000),
        },
      });
      await meter();
      expect((await stopJobs())[0]).toMatchObject({ payload: { reason: "max_awake" } });
      expect(await events(w)).toEqual(["max_awake"]);

      await t.db.delete(jobs);
      await t.db.delete(workspaceEvents);
      const p = await tinyPlan({
        allowanceRuntimeHours: 100,
        allowanceCpuCoreHours: 100,
        allowanceMemGbHours: 100,
        maxAwakeHours: null,
        idleTimeoutMinutes: null,
      });
      await t.db.update(subscriptions).set({ planId: p.id });
      await meter();
      expect(await stopJobs()).toHaveLength(0); // 13 h < global 24 h
    });
  });
});
