import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readSetting } from "@agentbox/db/client";
import { jobs, user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { grantAccess } from "../lib/approve";
import { deleteWorkspaceAsAdmin, stopWorkspaceAsAdmin } from "../lib/admin/workspace-lifecycle";
import { isAdminUser } from "../lib/session";
import { UserError } from "../lib/errors";
import { createTestDb, seedAdmin, seedUser, type TestDb } from "./helpers/db";
import { randomBytes } from "node:crypto";

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

const actor = () => ({ adminId, ip: null });
async function make(userId: string, slug: string) {
  await grantAccess(t.db, { userId, adminId, slug, planId, encryptionKey: KEY, ip: null });
  const [w] = await t.db.select().from(workspaces).where(eq(workspaces.userId, userId));
  await t.db.delete(jobs).where(eq(jobs.workspaceId, w!.id));
  return w!;
}
const setStatus = (id: string, status: (typeof workspaces.$inferInsert)["status"]) =>
  t.db.update(workspaces).set({ status }).where(eq(workspaces.id, id));
const jobTypes = async (id: string) =>
  (await t.db.select().from(jobs).where(eq(jobs.workspaceId, id))).map((j) => j.type);

describe("stopWorkspaceAsAdmin", () => {
  it.each(["running", "starting", "error"] as const)("queues a stop from %s", async (status) => {
    const w = await make(
      await seedUser(t.db, `stop-${status}@example.com`, "none"),
      `stop${status}`,
    );
    await setStatus(w.id, status);
    await stopWorkspaceAsAdmin(t.db, actor(), w.slug);
    expect(await jobTypes(w.id)).toEqual(["stop_workspace"]);
  });

  it("allows the admin's own workspace and refuses sleeping/deleted", async () => {
    const w = await make(adminId, "adminownstop");
    await setStatus(w.id, "running");
    await stopWorkspaceAsAdmin(t.db, actor(), w.slug);
    expect(await jobTypes(w.id)).toEqual(["stop_workspace"]);
    await setStatus(w.id, "deleted");
    await expect(stopWorkspaceAsAdmin(t.db, actor(), w.slug)).rejects.toThrow(UserError);
  });
});

describe("deleteWorkspaceAsAdmin", () => {
  it("keeps the admin able to use /admin when deleting their own workspace", async () => {
    const adm = await seedAdmin(t.db, "self@example.com");
    const w = await make(adm, "selfdel");
    await expect(deleteWorkspaceAsAdmin(t.db, actor(), w.slug, "wrong")).rejects.toThrow(
      /Type the workspace slug/,
    );
    await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, w.slug);
    const [after] = await t.db.select().from(workspaces).where(eq(workspaces.id, w.id));
    expect(after!.status).toBe("deleting");
    expect(await jobTypes(w.id)).toEqual(["delete_tenant"]);
    const [u] = await t.db.select().from(user).where(eq(user.id, adm));
    expect(u!.accessStatus).toBe("active");
    expect(isAdminUser(u!)).toBe(true);
    await expect(deleteWorkspaceAsAdmin(t.db, actor(), w.slug, w.slug)).rejects.toThrow(
      /Already deleted/,
    );
  });

  it.each(["provisioning", "error", "sleeping", "running"] as const)(
    "deletes a %s workspace of a regular user and suspends them",
    async (status) => {
      const uid = await seedUser(t.db, `del-${status}@example.com`, "none");
      const w = await make(uid, `del${status}`);
      await setStatus(w.id, status);
      await t.db.insert(workspaceSessions).values({
        userId: uid,
        workspaceId: w.id,
        tokenHash: `h-${status}`,
        host: `del${status}-t3.example.com`,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, w.slug);
      const [u] = await t.db.select().from(user).where(eq(user.id, uid));
      expect(u!.accessStatus).toBe("suspended");
      const [s] = await t.db
        .select()
        .from(workspaceSessions)
        .where(eq(workspaceSessions.userId, uid));
      expect(s!.revokedAt).not.toBeNull();
      expect(await jobTypes(w.id)).toEqual(["delete_tenant"]);
    },
  );
});
