import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MICRO_PER_CREDIT } from "@agentbox/core";
import { readSetting } from "@agentbox/db/client";
import { auditLog, creditBalances, creditLedger, jobs, subscriptions } from "@agentbox/db/schema";
import { addMonth, cycleTick } from "../src/cycle.ts";
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
      balance: 150n * MICRO_PER_CREDIT,
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
    expect(bal!.balanceMicro).toBe(50n * MICRO_PER_CREDIT);
    const [led] = await t.db.select().from(creditLedger);
    expect(led).toMatchObject({
      deltaMicro: -100n * MICRO_PER_CREDIT,
      reason: "package_fee",
      userId: w.userId,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    // Not due any more: a second tick does nothing.
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(0);
    expect(await t.db.select().from(creditLedger)).toHaveLength(1);
  });

  it("downgrades to the default plan with an audit row when credits do not cover the fee", async () => {
    const w = await seedWorld(t.db, {
      plan: "Pro",
      balance: 99n * MICRO_PER_CREDIT,
      cycleEnd: due,
      subscription: used,
    });
    await cycleTick(makeCtx(t.db, clock));
    const billing = await readSetting(t.db, "billing");
    const s = await sub(w);
    expect(s.planId).toBe(billing!.defaultPlanId);
    expect(s.planId).not.toBe(w.planId);
    expect(s.cycleEnd.toISOString()).toBe("2026-04-10T11:00:00.000Z");
    expect([s.usedRuntimeHours, s.usedCpuCoreHours, s.usedMemGbHours]).toEqual([0, 0, 0]);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(99n * MICRO_PER_CREDIT);
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
      toPlanId: billing!.defaultPlanId,
    });
    const queued = await t.db.select().from(jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: "update_limits", workspaceId: w.workspaceId });
  });

  it("resets free-plan usage without charging, and leaves undue subscriptions alone", async () => {
    const free = await seedWorld(t.db, {
      slug: "freee",
      slot: 1,
      plan: "Free",
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
      balance: 350n * MICRO_PER_CREDIT,
      cycleEnd: new Date("2026-01-10T11:00:00.000Z"),
    });
    // Ends Jan 10, Feb 10, Mar 10 11:00 are all past: 3 fees, new cycle ends Apr 10.
    expect(await cycleTick(makeCtx(t.db, clock))).toBe(3);
    const [bal] = await t.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, w.userId));
    expect(bal!.balanceMicro).toBe(50n * MICRO_PER_CREDIT);
    expect((await sub(w)).cycleEnd.toISOString()).toBe("2026-04-10T11:00:00.000Z");
    expect(await t.db.select().from(creditLedger)).toHaveLength(3);
  });
});
