import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readSetting } from "@agentbox/db/client";
import { agentKeys, jobs, user, workspaceSessions, workspaces } from "@agentbox/db/schema";
import { saveAgentKey } from "../lib/agent-keys";
import { grantAccess } from "../lib/approve";
import { createWorkspaceForUser } from "../lib/workspace-create";
import { saveSelection } from "../lib/onboarding-selection";
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
  await grantAccess(t.db, { userId, adminId, slug, planId, ip: null });
  await createWorkspaceForUser(t.db, { userId, encryptionKey: KEY });
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
    await expect(
      deleteWorkspaceAsAdmin(t.db, actor(), w.slug, {
        confirm: "wrong",
        keepData: false,
        afterDelete: "suspend",
      }),
    ).rejects.toThrow(/Type the workspace slug/);
    await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, wipeSuspend(w.slug));
    const [after] = await t.db.select().from(workspaces).where(eq(workspaces.id, w.id));
    expect(after!.status).toBe("deleting");
    expect(await jobTypes(w.id)).toEqual(["delete_tenant"]);
    const [u] = await t.db.select().from(user).where(eq(user.id, adm));
    expect(u!.accessStatus).toBe("active");
    expect(u!.onboardedAt).toBeNull();
    expect(isAdminUser(u!)).toBe(true);
    await expect(
      deleteWorkspaceAsAdmin(t.db, actor(), w.slug, wipeSuspend(w.slug)),
    ).rejects.toThrow(/Already deleted/);
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
      await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, wipeSuspend(w.slug));
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

  async function withSelectionAndKey(email: string, slug: string) {
    const uid = await seedUser(t.db, email, "none");
    const w = await make(uid, slug);
    await saveSelection(t.db, uid, "runtime", ["go"]);
    await saveAgentKey(
      t.db,
      { userId: uid, encryptionKey: KEY, ip: null },
      { agentId: "codex", envVar: "OPENAI_API_KEY", value: "sk-adminkeep12345678" },
    );
    await t.db.update(user).set({ onboardedAt: new Date() }).where(eq(user.id, uid));
    return { uid, w };
  }
  const deleteJob = async (id: string) =>
    (await t.db.select().from(jobs).where(eq(jobs.workspaceId, id))).find(
      (j) => j.type === "delete_tenant",
    );

  it("keep data + onboard again keeps access, selection and keys and resets onboarding", async () => {
    const { uid, w } = await withSelectionAndKey("keep-onboard@example.com", "keeponboard");
    await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, {
      confirm: w.slug,
      keepData: true,
      afterDelete: "onboard",
    });
    const [u] = await t.db.select().from(user).where(eq(user.id, uid));
    expect(u).toMatchObject({ accessStatus: "active", onboardedAt: null });
    expect(u!.onboardingSelection).not.toBeNull();
    expect(await t.db.select().from(agentKeys).where(eq(agentKeys.userId, uid))).toHaveLength(1);
    expect((await deleteJob(w.id))?.payload).toEqual({ keepData: true });
  });

  it("wipe + onboard again clears selection and keys and queues a wipe", async () => {
    const { uid, w } = await withSelectionAndKey("wipe-onboard@example.com", "wipeonboard");
    await deleteWorkspaceAsAdmin(t.db, actor(), w.slug, {
      confirm: w.slug,
      keepData: false,
      afterDelete: "onboard",
    });
    const [u] = await t.db.select().from(user).where(eq(user.id, uid));
    expect(u).toMatchObject({ accessStatus: "active", onboardedAt: null, onboardingSelection: null });
    expect(await t.db.select().from(agentKeys).where(eq(agentKeys.userId, uid))).toHaveLength(0);
    expect((await deleteJob(w.id))?.payload).toEqual({ keepData: false });
  });
});

function wipeSuspend(slug: string) {
  return { confirm: slug, keepData: false, afterDelete: "suspend" as const };
}
