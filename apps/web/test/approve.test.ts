import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { decrypt } from "@agentbox/core/tokens";
import { readSetting } from "@agentbox/db/client";
import {
  accessRequests,
  auditLog,
  creditBalances,
  jobs,
  subscriptions,
  user,
  workspaces,
} from "@agentbox/db/schema";
import { grantAccess, openAccessRequest } from "../lib/approve";
import { UserError } from "../lib/errors";
import { createTestDb, seedAdmin, seedRequester, seedUser, type TestDb } from "./helpers/db";

const KEY = randomBytes(32).toString("base64");
let t: TestDb;
let adminId: string;
let planId: string;
beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
  planId = (await readSetting(t.db, "billing"))!.defaultPlanId;
});
afterAll(() => t.close());

const input = (userId: string, slug: string, now?: Date) => ({
  userId,
  adminId,
  slug,
  planId,
  encryptionKey: KEY,
  ip: "198.51.100.7",
  now,
});

describe("grantAccess", () => {
  it("applies every effect of the plan in one transaction", async () => {
    const { userId, requestId } = await seedRequester(t.db, "alice@example.com");
    const now = new Date("2026-01-31T10:00:00Z");
    const res = await grantAccess(t.db, input(userId, "alice", now));
    expect(res.slot).toBeGreaterThanOrEqual(1);

    const [req] = await t.db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
    expect(req).toMatchObject({ status: "approved", decidedBy: adminId });
    expect(req!.decidedAt).toEqual(now);

    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u!.accessStatus).toBe("active");

    const [sub] = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub).toMatchObject({
      planId,
      usedRuntimeHours: 0,
      usedCpuCoreHours: 0,
      usedMemGbHours: 0,
    });
    expect(sub!.cycleStart).toEqual(now);
    expect(sub!.cycleEnd).toEqual(new Date("2026-02-28T10:00:00Z"));

    const [bal] = await t.db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
    expect(bal!.balanceMicro).toBe(0n);

    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.userId, userId));
    expect(ws).toMatchObject({
      slug: "alice",
      slot: res.slot,
      status: "provisioning",
      imageId: null,
    });
    expect(ws!.id).toBe(res.workspaceId);
    expect(decrypt(ws!.identitySecretEnc, KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const j = await t.db.select().from(jobs).where(eq(jobs.workspaceId, ws!.id));
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ type: "provision_tenant", status: "queued", payload: {} });

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "access.approve"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: adminId, targetId: userId, ip: "198.51.100.7" });
  });

  it("allocates distinct increasing slots", async () => {
    const a = await seedRequester(t.db, "slota@example.com");
    const b = await seedRequester(t.db, "slotb@example.com");
    const ra = await grantAccess(t.db, input(a.userId, "slota"));
    const rb = await grantAccess(t.db, input(b.userId, "slotb"));
    expect(rb.slot).toBeGreaterThan(ra.slot);
  });

  it("refuses a user who already has a workspace", async () => {
    const { userId } = await seedRequester(t.db, "twice@example.com");
    await grantAccess(t.db, input(userId, "twice"));
    await expect(grantAccess(t.db, input(userId, "twice2"))).rejects.toThrow(
      "already has a workspace",
    );
  });

  it.each(["none", "suspended", "rejected"] as const)(
    "approves a %s user who never got a workspace and records the decision",
    async (status) => {
      const userId = await seedUser(t.db, `${status}@example.com`, status);
      await grantAccess(t.db, input(userId, `was${status}`));
      const [u] = await t.db.select().from(user).where(eq(user.id, userId));
      expect(u!.accessStatus).toBe("active");
      const reqs = await t.db
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.userId, userId));
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ status: "approved", decidedBy: adminId });
      expect(
        await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId)),
      ).toHaveLength(1);
    },
  );

  it("gives an already-active account without a workspace one, without inventing a request", async () => {
    const userId = await seedUser(t.db, "boot@example.com", "active");
    await grantAccess(t.db, input(userId, "boot"));
    expect(await t.db.select().from(workspaces).where(eq(workspaces.userId, userId))).toHaveLength(
      1,
    );
    expect(
      await t.db.select().from(accessRequests).where(eq(accessRequests.userId, userId)),
    ).toHaveLength(0);
  });

  it("rolls back everything when the slug is invalid, reserved or taken", async () => {
    const { userId, requestId } = await seedRequester(t.db, "bad@example.com");
    const seqBefore = (
      await t.db.execute<{ last_value: string; is_called: boolean }>(
        sql`select last_value, is_called from tenant_slot_seq`,
      )
    ).rows[0]!;
    for (const [slug, msg] of [
      ["Bad Slug", "Slug must be"],
      ["admin", "reserved"],
      ["alice", "already taken"],
    ] as const) {
      await expect(grantAccess(t.db, input(userId, slug))).rejects.toThrow(msg);
    }
    const [req] = await t.db.select().from(accessRequests).where(eq(accessRequests.id, requestId));
    expect(req!.status).toBe("pending");
    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u!.accessStatus).toBe("pending");
    expect(await t.db.select().from(workspaces).where(eq(workspaces.userId, userId))).toHaveLength(
      0,
    );
    expect(
      await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userId)),
    ).toHaveLength(0);
    const seqAfter = (
      await t.db.execute<{ last_value: string; is_called: boolean }>(
        sql`select last_value, is_called from tenant_slot_seq`,
      )
    ).rows[0]!;
    expect(seqAfter).toEqual(seqBefore);
  });

  it("rejects an unknown plan", async () => {
    const { userId } = await seedRequester(t.db, "noplan@example.com");
    await expect(
      grantAccess(t.db, {
        ...input(userId, "noplan"),
        planId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(UserError);
  });
});

describe("openAccessRequest", () => {
  it("queues a new user for review exactly once and leaves other statuses alone", async () => {
    const fresh = await seedUser(t.db, "fresh@example.com", "none");
    await openAccessRequest(t.db, fresh);
    await openAccessRequest(t.db, fresh);
    const [u] = await t.db.select().from(user).where(eq(user.id, fresh));
    expect(u!.accessStatus).toBe("pending");
    const reqs = await t.db.select().from(accessRequests).where(eq(accessRequests.userId, fresh));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.status).toBe("pending");

    const active = await seedUser(t.db, "already@example.com", "active");
    await openAccessRequest(t.db, active);
    expect(
      await t.db.select().from(accessRequests).where(eq(accessRequests.userId, active)),
    ).toHaveLength(0);
  });
});
