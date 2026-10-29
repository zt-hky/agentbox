import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  creditBalances,
  auditLog,
  creditLedger,
  jobs,
  subscriptions,
  workspaces,
} from "@agentbox/db/schema";
import { FREE_PLAN_ID, CREDITS_ONLY_PLAN_ID } from "@agentbox/core/billing";
import { grantAccess } from "../lib/approve";
import { UserError } from "../lib/errors";
import { changeUserPlanTx } from "../lib/plan-change";
import { createTestDb, seedAdmin, seedRequester, type TestDb } from "./helpers/db";
import { randomBytes } from "node:crypto";

const PRO = "00000000-0000-4000-8000-0000000000a3";
const MAX = "00000000-0000-4000-8000-0000000000a4";
const KEY = randomBytes(32).toString("base64");
const NOW = new Date("2026-03-10T08:00:00Z");

let t: TestDb;
let adminId: string;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
});
afterAll(() => t.close());

/** A granted user on the Free trial with `credits` whole credits. */
async function freeUser(credits: number) {
  const { userId } = await seedRequester(t.db, `u${++n}@example.com`);
  await grantAccess(t.db, {
    userId,
    adminId,
    slug: `user${n}`,
    planId: FREE_PLAN_ID,
    encryptionKey: KEY,
    ip: null,
    now: NOW,
  });
  await t.db
    .update(creditBalances)
    .set({ balanceMicro: BigInt(credits) * 1_000_000n })
    .where(eq(creditBalances.userId, userId));
  return userId;
}

const change = (userId: string, planId: string, fee: "charge" | "waive") =>
  changeUserPlanTx(t.db, { userId, planId, fee, adminId, ip: "198.51.100.9", now: NOW });

const balanceOf = async (userId: string) =>
  (await t.db.select().from(creditBalances).where(eq(creditBalances.userId, userId)))[0]!
    .balanceMicro;

describe("changeUserPlanTx", () => {
  it("approving on Free starts a 5-day trial", async () => {
    const userId = await freeUser(0);
    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub!.trialEndsAt).toEqual(new Date("2026-03-15T08:00:00Z"));
  });

  it("charges the first month, starts a cycle and clears the trial", async () => {
    const userId = await freeUser(200);
    const res = await change(userId, PRO, "charge");
    expect(res).toEqual({
      chargedMicro: 139_000_000n,
      waivedMicro: 0n,
      balanceMicro: 61_000_000n,
    });
    expect(await balanceOf(userId)).toBe(61_000_000n);

    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub).toMatchObject({
      planId: PRO,
      trialEndsAt: null,
      dayStart: null,
      usedTodayRuntimeHours: 0,
      usedRuntimeHours: 0,
    });
    expect(sub!.cycleStart).toEqual(NOW);
    expect(sub!.cycleEnd).toEqual(new Date("2026-04-10T08:00:00Z"));

    const [fee] = await t.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(desc(creditLedger.createdAt));
    expect(fee).toMatchObject({
      reason: "package_fee",
      deltaMicro: -139_000_000n,
      actorId: adminId,
    });

    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.userId, userId));
    const queued = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, ws!.id), eq(jobs.type, "update_limits")));
    expect(queued).toHaveLength(1);

    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, "user.plan_change")));
    expect(audit!.metadata).toMatchObject({
      from: FREE_PLAN_ID,
      to: PRO,
      chargedMicro: "139000000",
      waived: false,
    });
  });

  it("charges exactly the balance (boundary)", async () => {
    const userId = await freeUser(249);
    await change(userId, MAX, "charge");
    expect(await balanceOf(userId)).toBe(0n);
  });

  it("refuses an insufficient balance and changes nothing", async () => {
    const userId = await freeUser(100);
    await expect(change(userId, PRO, "charge")).rejects.toThrow(UserError);
    await expect(change(userId, PRO, "charge")).rejects.toThrow(
      /Insufficient credits.*139 credits \(139\.000 ₫\)/,
    );
    expect(await balanceOf(userId)).toBe(100_000_000n);
    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub!.planId).toBe(FREE_PLAN_ID);
    expect(sub!.trialEndsAt).not.toBeNull();
    const ledger = await t.db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    expect(ledger.filter((l) => l.reason === "package_fee")).toHaveLength(0);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, "user.plan_change")));
    expect(audits).toHaveLength(0);
  });

  it("waives the fee even with no balance, and audits the waiver", async () => {
    const userId = await freeUser(0);
    const res = await change(userId, PRO, "waive");
    expect(res).toEqual({ chargedMicro: 0n, waivedMicro: 139_000_000n, balanceMicro: 0n });
    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub!.planId).toBe(PRO);
    expect(sub!.cycleEnd).toEqual(new Date("2026-04-10T08:00:00Z"));
    const ledger = await t.db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    expect(ledger.filter((l) => l.reason === "package_fee")).toHaveLength(0);
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, "user.plan_change")));
    expect(audit!.metadata).toMatchObject({
      waived: true,
      waivedMicro: "139000000",
      chargedMicro: "0",
    });
  });

  it("moving to a non-package plan never charges, even with fee=charge", async () => {
    const userId = await freeUser(0);
    const res = await change(userId, CREDITS_ONLY_PLAN_ID, "charge");
    expect(res.chargedMicro).toBe(0n);
    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub).toMatchObject({ planId: CREDITS_ONLY_PLAN_ID, trialEndsAt: null });
  });

  it("rejects the same plan, an inactive plan and an unknown user", async () => {
    const userId = await freeUser(0);
    await expect(change(userId, FREE_PLAN_ID, "waive")).rejects.toThrow(/already on this plan/);
    await expect(change("nobody", PRO, "waive")).rejects.toThrow(/User not found/);
  });
});
