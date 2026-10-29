import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, creditBalances, creditLedger } from "@agentbox/db/schema";
import { adjustCredits } from "../lib/credits";
import { UserError } from "../lib/errors";
import { createTestDb, seedAdmin, seedRequester, type TestDb } from "./helpers/db";

let t: TestDb;
let adminId: string;
let userId: string;
beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
  userId = (await seedRequester(t.db, "credit@example.com")).userId;
});
afterAll(() => t.close());

const base = () => ({ userId, actorId: adminId, ip: "203.0.113.9" });

describe("adjustCredits", () => {
  it("add -> positive admin_topup row, balance, audit", async () => {
    const r = await adjustCredits(t.db, {
      ...base(),
      amount: "5.25",
      direction: "add",
      note: "welcome",
    });
    expect(r).toEqual({ balanceMicro: 5_250_000n, deltaMicro: 5_250_000n });
    const ledger = await t.db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      deltaMicro: 5_250_000n,
      reason: "admin_topup",
      note: "welcome",
      actorId: adminId,
    });
    const [bal] = await t.db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
    expect(bal!.balanceMicro).toBe(5_250_000n);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "credits.topup"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: adminId, targetId: userId, ip: "203.0.113.9" });
  });

  it("remove -> negative adjustment row", async () => {
    const r = await adjustCredits(t.db, {
      ...base(),
      amount: "1.5",
      direction: "remove",
      note: "chargeback",
    });
    expect(r.deltaMicro).toBe(-1_500_000n);
    expect(r.balanceMicro).toBe(3_750_000n);
    const ledger = await t.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.reason, "adjustment"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.deltaMicro).toBe(-1_500_000n);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "credits.adjust")),
    ).toHaveLength(1);
  });

  it("requires a note", async () => {
    await expect(
      adjustCredits(t.db, { ...base(), amount: "1", direction: "add", note: "   " }),
    ).rejects.toThrow(UserError);
  });

  it("rejects non-positive and malformed amounts", async () => {
    for (const amount of ["0", "-1", "abc", "1.1234567", ""]) {
      await expect(
        adjustCredits(t.db, { ...base(), amount, direction: "add", note: "x" }),
      ).rejects.toThrow(UserError);
    }
  });

  it("refuses to go below zero and leaves no trace", async () => {
    const before = await t.db.select().from(creditLedger);
    await expect(
      adjustCredits(t.db, { ...base(), amount: "100", direction: "remove", note: "too much" }),
    ).rejects.toThrow("negative");
    expect(await t.db.select().from(creditLedger)).toHaveLength(before.length);
    const [bal] = await t.db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
    expect(bal!.balanceMicro).toBe(3_750_000n);
  });
});
