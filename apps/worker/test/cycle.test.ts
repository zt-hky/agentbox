import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CREDITS_ONLY_PLAN_ID, MICRO_PER_CREDIT } from "@agentbox/core";
import {
  auditLog,
  creditBalances,
  creditLedger,
  jobs,
  subscriptions,
  workspaceEvents,
  workspaces,
} from "@agentbox/db/schema";
import { addMonth, cycleTick, expireTrials } from "../src/cycle.ts";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { seedWorld, type World } from "./helpers/seed.ts";

let t: TestDb;
const clock = createClock(new Date("2026-03-10T12:00:00.000Z"));
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  clock.set(new Date("2026-03-10T12:00:00.000Z"));
  await resetDb(t.db);
});

const sub = async (w: World) =>
  (await t.db.select().from(subscriptions).where(eq(subscriptions.id, w.subscriptionId)))[0]!;
const used = { usedRuntimeHours: 5, usedCpuCoreHours: 6, usedMemGbHours: 7 };
const MAX_PLAN_ID = "00000000-0000-4000-8000-0000000000a4";
const PRO_FEE = 139n * MICRO_PER_CREDIT;
const MAX_FEE = 249n * MICRO_PER_CREDIT;
const due = new Date("2026-03-10T11:00:00.000Z");

describe("addMonth", () => {
  it("advances one calendar month and clamps the day", () => {
    expect(addMonth(new Date("2026-01-31T10:00:00Z")).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addMonth(new Date("2028-01-31T10:00:00Z")).toISOString()).toBe(
      "2028-02-29T10:00:00.000Z",
    );
    expect(addMonth(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });
});

describe("cycle loop", () => {
  it("debits the package fee when the balance covers it and resets usage", async () => {
    const w = await seedWorld(t.db, {
      plan: "Pro",
      balance: 150n * MICRO_PER_CREDIT, // Pro: 139 credits/month
      cycleEnd: due,
      subscription: used,
    });
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(1);
    const s = await sub(w);
    expect(s.planId).toBe(w.planId);
    expect(s.cycleStart.toISOString()).toBe(due.toISOString());
    expect(s.cycleEnd.toISOString()).toBe("2026-04-10T11:00:00.000Z");
    expect([s.usedRuntimeHours, s.usedCpuCoreHours, s.usedMemGbHours]).toEqual([0, 0, 0]);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(150n * MICRO_PER_CREDIT - PRO_FEE);
    const [led] = await t.db.select().from(creditLedger);
    expect(led).toMatchObject({
      deltaMicro: -PRO_FEE,
      reason: "package_fee",
      userId: w.userId,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    // Not due any more: a second tick does nothing.
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(0);
    expect(await t.db.select().from(creditLedger)).toHaveLength(1);
  });

  it("downgrades to Credits only (not Free) with an audit row when credits do not cover the fee", async () => {
    const w = await seedWorld(t.db, {
      plan: "Pro",
      balance: 138n * MICRO_PER_CREDIT,
      cycleEnd: due,
      subscription: used,
    });
    await cycleTick(makeCtx(t.db, clock));
    const s = await sub(w);
    expect(s.planId).toBe(CREDITS_ONLY_PLAN_ID);
    expect(s.planId).not.toBe(w.planId);
    expect(s.cycleEnd.toISOString()).toBe("2026-04-10T11:00:00.000Z");
    expect([s.usedRuntimeHours, s.usedCpuCoreHours, s.usedMemGbHours]).toEqual([0, 0, 0]);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(138n * MICRO_PER_CREDIT);
    expect(await t.db.select().from(creditLedger)).toHaveLength(0);
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: "subscription.downgraded_insufficient_credits",
      targetType: "subscription",
      targetId: w.subscriptionId,
      actorId: null,
    });
    expect(audit!.metadata).toMatchObject({
      userId: w.userId,
      fromPlanId: w.planId,
      toPlanId: CREDITS_ONLY_PLAN_ID,
    });
    const queued = await t.db.select().from(jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: "update_limits", workspaceId: w.workspaceId });
  });

  it("resets free-plan usage without charging, and leaves undue subscriptions alone", async () => {
    const free = await seedWorld(t.db, {
      slug: "freee",
      slot: 1,
      plan: "Free trial",
      cycleEnd: due,
      subscription: used,
    });
    const later = await seedWorld(t.db, {
      slug: "later",
      slot: 2,
      plan: "Pro",
      balance: 500n * MICRO_PER_CREDIT,
      cycleEnd: new Date("2026-03-10T12:00:01.000Z"),
      subscription: used,
    });
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(1);
    expect((await sub(free)).usedRuntimeHours).toBe(0);
    expect((await sub(later)).usedRuntimeHours).toBe(5);
    expect(await t.db.select().from(creditLedger)).toHaveLength(0);
  });

  it("catches up month by month after downtime, charging one fee per elapsed cycle", async () => {
    const w = await seedWorld(t.db, {
      plan: "Pro",
      balance: 450n * MICRO_PER_CREDIT,
      cycleEnd: new Date("2026-01-10T11:00:00.000Z"),
    });
    // Ends Jan 10, Feb 10, Mar 10 11:00 are all past: 3 fees of 139, new cycle ends Apr 10.
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(3);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(450n * MICRO_PER_CREDIT - 3n * PRO_FEE);
    expect((await sub(w)).cycleEnd.toISOString()).toBe("2026-04-10T11:00:00.000Z");
    expect(await t.db.select().from(creditLedger)).toHaveLength(3);
  });

  it("Max renewal debits 249 credits", async () => {
    const w = await seedWorld(t.db, {
      planId: MAX_PLAN_ID,
      balance: 300n * MICRO_PER_CREDIT,
      cycleEnd: due,
    });
    await cycleTick(makeCtx(t.db, clock));
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(300n * MICRO_PER_CREDIT - MAX_FEE);
    expect((await sub(w)).planId).toBe(MAX_PLAN_ID);
  });

  it("Max with too little credit drops to Credits only, keeping the balance", async () => {
    const w = await seedWorld(t.db, {
      planId: MAX_PLAN_ID,
      balance: 248n * MICRO_PER_CREDIT,
      cycleEnd: due,
    });
    await cycleTick(makeCtx(t.db, clock));
    expect((await sub(w)).planId).toBe(CREDITS_ONLY_PLAN_ID);
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.action).toBe("subscription.downgraded_insufficient_credits");
  });
});

describe("trial expiry", () => {
  const trialEnd = new Date("2026-03-10T12:00:00.000Z"); // == now: boundary is inclusive

  it("switches to Credits only at exactly trialEndsAt, stops a running workspace, audits, keeps balance", async () => {
    const w = await seedWorld(t.db, {
      plan: "Free trial",
      balance: 5n * MICRO_PER_CREDIT,
      subscription: {
        ...used,
        trialEndsAt: trialEnd,
        usedTodayRuntimeHours: 2,
        dayStart: "2026-03-10",
      },
    });
    expect(await expireTrials(makeCtx(t.db, clock))).toBe(1);
    const s = await sub(w);
    expect(s.planId).toBe(CREDITS_ONLY_PLAN_ID);
    expect([
      s.usedRuntimeHours,
      s.usedCpuCoreHours,
      s.usedMemGbHours,
      s.usedTodayRuntimeHours,
    ]).toEqual([0, 0, 0, 0]);
    expect(s.cycleStart.toISOString()).toBe(clock.now().toISOString());
    expect(s.cycleEnd.toISOString()).toBe("2026-04-10T12:00:00.000Z");
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: "subscription.trial_ended",
      targetType: "subscription",
      targetId: w.subscriptionId,
      actorId: null,
    });
    expect(audit!.metadata).toMatchObject({ userId: w.userId, toPlanId: CREDITS_ONLY_PLAN_ID });
    const queued = await t.db.select().from(jobs);
    expect(queued.map((j) => j.type).sort()).toEqual(["stop_workspace", "update_limits"]);
    expect(queued.find((j) => j.type === "stop_workspace")).toMatchObject({
      workspaceId: w.workspaceId,
      payload: { reason: "trial_ended" },
    });
    const evs = await t.db.select().from(workspaceEvents);
    expect(evs.map((e) => e.type)).toEqual(["trial_ended"]);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(5n * MICRO_PER_CREDIT);
    // Idempotent.
    expect(await expireTrials(makeCtx(t.db, clock))).toBe(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it("does nothing one millisecond before the trial end", async () => {
    const w = await seedWorld(t.db, {
      plan: "Free trial",
      subscription: { trialEndsAt: new Date(clock.now().getTime() + 1) },
    });
    expect(await expireTrials(makeCtx(t.db, clock))).toBe(0);
    expect((await sub(w)).planId).toBe(w.planId);
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it("a sleeping workspace is not stopped (only limits are re-applied); a stale stop is not duplicated", async () => {
    await seedWorld(t.db, {
      plan: "Free trial",
      status: "sleeping",
      subscription: { trialEndsAt: trialEnd },
    });
    await expireTrials(makeCtx(t.db, clock));
    expect((await t.db.select().from(jobs)).map((j) => j.type)).toEqual(["update_limits"]);
    expect(await t.db.select().from(workspaceEvents)).toHaveLength(0);
  });

  it("Pro/Max/Credits-only subscriptions with a leftover trialEndsAt are untouched; the cycle loop runs expiry", async () => {
    const pro = await seedWorld(t.db, {
      slug: "prouser",
      slot: 1,
      plan: "Pro",
      subscription: { trialEndsAt: trialEnd },
    });
    expect(await expireTrials(makeCtx(t.db, clock))).toBe(0);
    expect((await sub(pro)).planId).toBe(pro.planId);
    const free = await seedWorld(t.db, {
      slug: "freeuser",
      slot: 2,
      plan: "Free trial",
      subscription: { trialEndsAt: trialEnd },
    });
    await cycleTick(makeCtx(t.db, clock));
    expect((await sub(free)).planId).toBe(CREDITS_ONLY_PLAN_ID);
    expect((await t.db.select().from(workspaces)).length).toBe(2);
  });
});
