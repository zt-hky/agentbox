import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { readSetting } from "@agentbox/db/client";
import {
  accessRequests,
  auditLog,
  creditBalances,
  jobs,
  plans,
  subscriptions,
  user,
  workspaces,
} from "@agentbox/db/schema";
import { grantAccess, openAccessRequest, recreateWorkspace } from "../lib/approve";
import { createWorkspaceForUser } from "../lib/workspace-create";
import { checkSlugAvailable, suggestAvailableSlug } from "../lib/slug-taken";
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
  ip: "198.51.100.7",
  now,
});

describe("grantAccess", () => {
  it("applies every effect of the plan in one transaction", async () => {
    const { userId, requestId } = await seedRequester(t.db, "alice@example.com");
    const now = new Date("2026-01-31T10:00:00Z");
    const res = await grantAccess(t.db, input(userId, "alice", now));
    expect(res).toEqual({ userId, slug: "alice" });

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

    // Approval activates access and reserves the slug; it never creates or provisions a workspace.
    expect(u!.reservedSlug).toBe("alice");
    expect(u!.onboardedAt).toBeNull();
    expect(await t.db.select().from(workspaces).where(eq(workspaces.userId, userId))).toHaveLength(
      0,
    );
    expect(await t.db.select().from(jobs).where(eq(jobs.type, "provision_tenant"))).toHaveLength(0);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "access.approve"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: adminId, targetId: userId, ip: "198.51.100.7" });
  });

  it("refuses a user who already has a workspace", async () => {
    const { userId } = await seedRequester(t.db, "twice@example.com");
    await grantAccess(t.db, input(userId, "twice"));
    await createWorkspaceForUser(t.db, { userId, encryptionKey: KEY });
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

  it("gives an already-active account a plan and slug, without inventing a request", async () => {
    const userId = await seedUser(t.db, "boot@example.com", "active");
    await grantAccess(t.db, input(userId, "boot"));
    expect((await t.db.select().from(user).where(eq(user.id, userId)))[0]!.reservedSlug).toBe(
      "boot",
    );
    expect(
      await t.db.select().from(accessRequests).where(eq(accessRequests.userId, userId)),
    ).toHaveLength(0);
  });

  it("rolls back everything when the slug is invalid, reserved or taken", async () => {
    const { userId, requestId } = await seedRequester(t.db, "bad@example.com");
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

describe("checkSlugAvailable", () => {
  it("rejects slugs taken by a workspace, reserved, or requested by another pending user", async () => {
    const owner = await seedRequester(t.db, "wsowner@example.com");
    await grantAccess(t.db, input(owner.userId, "wsowner"));
    const a = await seedRequester(t.db, "reqa@example.com");
    const b = await seedRequester(t.db, "reqb@example.com");
    await t.db
      .update(accessRequests)
      .set({ requestedSlug: "wanted" })
      .where(eq(accessRequests.id, a.requestId));

    expect(await checkSlugAvailable(t.db, "wsowner", b.userId)).toEqual({
      ok: false,
      error: '"wsowner" is already taken',
    });
    expect(await checkSlugAvailable(t.db, "admin", b.userId)).toMatchObject({ ok: false });
    expect(await checkSlugAvailable(t.db, "wanted", b.userId)).toEqual({
      ok: false,
      error: '"wanted" is already taken',
    });
    expect(await checkSlugAvailable(t.db, "wanted", a.userId)).toEqual({ ok: true });
    expect(await checkSlugAvailable(t.db, "freeone", b.userId)).toEqual({ ok: true });
  });

  it("suggests a free slug when another user with the same email name took it", async () => {
    const first = await seedRequester(t.db, "same.name@galaxy.example");
    await grantAccess(t.db, input(first.userId, "samename"));
    const second = await seedRequester(t.db, "same.name@vikki.example");
    expect(
      await suggestAvailableSlug(t.db, { email: "same.name@vikki.example", userId: second.userId }),
    ).toBe("samenamevikki");
    await grantAccess(t.db, input(second.userId, "samenamevikki"));
    const third = await seedRequester(t.db, "same.name@vikki.example2");
    expect(
      await suggestAvailableSlug(t.db, { email: "same.name@vikki.example2", userId: third.userId }),
    ).toBe("samename2");
    expect(
      await suggestAvailableSlug(t.db, {
        email: "same.name@vikki.example2",
        userId: third.userId,
        requestedSlug: "mine",
      }),
    ).toBe("mine");
  });

  it("grantAccess honours the user's own requested slug but not another user's", async () => {
    const a = await seedRequester(t.db, "owna@example.com");
    const b = await seedRequester(t.db, "ownb@example.com");
    await t.db
      .update(accessRequests)
      .set({ requestedSlug: "mine" })
      .where(eq(accessRequests.id, a.requestId));
    await expect(grantAccess(t.db, input(b.userId, "mine"))).rejects.toThrow("already taken");
    await expect(grantAccess(t.db, input(a.userId, "mine"))).resolves.toMatchObject({
      userId: a.userId,
    });
  });

  it("allows only one pending request per requested slug", async () => {
    const a = await seedRequester(t.db, "uqa@example.com");
    const b = await seedRequester(t.db, "uqb@example.com");
    await t.db
      .update(accessRequests)
      .set({ requestedSlug: "dupe" })
      .where(eq(accessRequests.id, a.requestId));
    await expect(
      t.db
        .update(accessRequests)
        .set({ requestedSlug: "dupe" })
        .where(eq(accessRequests.id, b.requestId)),
    ).rejects.toThrow();
  });
});

describe("recreateWorkspace", () => {
  const markDeleted = async (
    userId: string,
    status: "deleted" | "deleting" = "deleted",
    dataKept = false,
  ) => {
    await t.db.update(workspaces).set({ status, dataKept }).where(eq(workspaces.userId, userId));
  };
  const granted = async (email: string, slug: string) => {
    const userId = await seedUser(t.db, email, "none");
    await grantAccess(t.db, input(userId, slug));
    const { workspaceId } = await createWorkspaceForUser(t.db, { userId, encryptionKey: KEY });
    return { userId, workspaceId };
  };

  it("re-approves a deleted workspace's user: active, slug reserved, onboarding reset, nothing provisioned", async () => {
    const g = await granted("re1@example.com", "recone");
    await t.db.delete(jobs).where(eq(jobs.workspaceId, g.workspaceId));
    await markDeleted(g.userId);
    await t.db
      .update(user)
      .set({ accessStatus: "suspended", onboardedAt: new Date() })
      .where(eq(user.id, g.userId));
    const [subBefore] = await t.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, g.userId));

    const res = await recreateWorkspace(t.db, input(g.userId, "recone"));
    expect(res).toEqual({ userId: g.userId, slug: "recone" });

    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.userId, g.userId));
    expect(ws).toMatchObject({ slug: "recone", status: "deleted" }); // reused at onboarding
    expect(await t.db.select().from(jobs).where(eq(jobs.workspaceId, ws!.id))).toHaveLength(0);
    const [u] = await t.db.select().from(user).where(eq(user.id, g.userId));
    expect(u).toMatchObject({ accessStatus: "active", reservedSlug: "recone", onboardedAt: null });
    const [subAfter] = await t.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, g.userId));
    expect(subAfter).toEqual(subBefore); // same plan: no second trial, cycle untouched
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.targetId, ws!.id));
    expect(audit.map((a) => a.action)).toContain("workspace.recreate");
  });

  it("allows a different slug, freeing the old one only for the same user", async () => {
    const g = await granted("re2@example.com", "rectwo");
    await markDeleted(g.userId);
    const other = await seedUser(t.db, "re2other@example.com", "none");
    await expect(grantAccess(t.db, input(other, "rectwo"))).rejects.toThrow(UserError);
    expect((await checkSlugAvailable(t.db, "rectwo", g.userId)).ok).toBe(true);
    expect((await checkSlugAvailable(t.db, "rectwo", other)).ok).toBe(false);

    await recreateWorkspace(t.db, input(g.userId, "rectwonew"));
    const [u] = await t.db.select().from(user).where(eq(user.id, g.userId));
    expect(u!.reservedSlug).toBe("rectwonew");
  });

  it("keeps the slug when the workspace's data was kept", async () => {
    const g = await granted("re5@example.com", "recfive");
    await markDeleted(g.userId, "deleted", true);
    await expect(recreateWorkspace(t.db, input(g.userId, "recfivenew"))).rejects.toThrow(
      /kept data belongs to "recfive"/,
    );
    await recreateWorkspace(t.db, input(g.userId, "recfive"));
  });

  it("refuses while deleting, while live, and another user's slug", async () => {
    const g = await granted("re3@example.com", "recthree");
    await expect(recreateWorkspace(t.db, input(g.userId, "recthree"))).rejects.toThrow(
      /Delete the current workspace/,
    );
    await markDeleted(g.userId, "deleting");
    await expect(recreateWorkspace(t.db, input(g.userId, "recthree"))).rejects.toThrow(
      /still being deleted/,
    );
    await markDeleted(g.userId);
    await granted("re3b@example.com", "recthreeb");
    await expect(recreateWorkspace(t.db, input(g.userId, "recthreeb"))).rejects.toThrow(UserError);
    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.userId, g.userId));
    expect(ws).toMatchObject({ status: "deleted", slug: "recthree" });
    await expect(recreateWorkspace(t.db, input("nobody", "recx"))).rejects.toThrow(UserError);
  });

  it("a plan change swaps the plan without a new trial", async () => {
    const g = await granted("re4@example.com", "recfour");
    await markDeleted(g.userId);
    const [other] = await t.db.select().from(plans).where(ne(plans.id, planId)).limit(1);
    const [subBefore] = await t.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, g.userId));
    await recreateWorkspace(t.db, { ...input(g.userId, "recfour"), planId: other!.id });
    const [subAfter] = await t.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, g.userId));
    expect(subAfter).toMatchObject({
      planId: other!.id,
      trialEndsAt: subBefore!.trialEndsAt,
      cycleStart: subBefore!.cycleStart,
    });
  });
});
