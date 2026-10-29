import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StatsResponse } from "@agentbox/core/agent-api";
import {
  creditBalances,
  creditLedger,
  hostStats,
  jobs,
  plans,
  subscriptions,
  usageSamples,
  workspaceEvents,
  workspaces,
} from "@agentbox/db/schema";
import { createMeteringState, meterTick } from "../src/metering.ts";
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

    // runtime overflow 24 s = 0.006667 h * 500000 = 3333.33; cpu overflow 18 s = 0.005 h * 200000 = 1000
    const [sample] = await t.db.select().from(usageSamples);
    expect(sample).toMatchObject({
      runtimeSec: 60,
      cpuCoreSec: 36,
      memGbSec: 60,
      chargeMicro: 4333n,
    });
    expect(sample!.ts.getTime()).toBe(clock.now().getTime());
    const [led] = await t.db.select().from(creditLedger);
    expect(led).toMatchObject({
      deltaMicro: -4333n,
      reason: "usage",
      workspaceId: w.workspaceId,
      userId: w.userId,
    });
    expect(await balance(w)).toBe(1_000_000n - 4333n);
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
    // 60 s runtime at 500000/h = 8333 µ > 100 → balance goes negative
    expect(await balance(w)).toBe(100n - 8333n);
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
      type: "sync_github" as const,
      workspaceId: null,
      status,
      finishedAt,
    });
    const day = 24 * 3600_000;
    await t.db.insert(jobs).values([
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
