import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, images, jobs, workspaces } from "@agentbox/db/schema";
import { UserError } from "../lib/errors";
import { cancelJob, listJobs, retryJob } from "../lib/admin/system-jobs";
import { createTestDb, seedAdmin, seedUser, type TestDb } from "./helpers/db";

let imageVersionCounter = 0;
const nextImageVersion = () => ++imageVersionCounter;

let t: TestDb;
let adminId: string;
let wsId: string;
let slot = 0;
const admin = () => ({ id: adminId, email: "admin@example.com" });
const ip = "198.51.100.7";

async function newWorkspace(slug: string) {
  const userId = await seedUser(t.db, `${slug}@example.com`, "active");
  const [w] = await t.db
    .insert(workspaces)
    .values({ userId, slug, slot: ++slot, status: "sleeping", identitySecretEnc: "x" })
    .returning({ id: workspaces.id });
  return w!.id;
}

async function addJob(values: Partial<typeof jobs.$inferInsert>) {
  const [j] = await t.db
    .insert(jobs)
    .values({ type: "start_workspace", workspaceId: wsId, ...values })
    .returning();
  return j!;
}

const reload = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
  wsId = await newWorkspace(`wsa${randomBytes(2).toString("hex")}`);
});
afterAll(() => t.close());

describe("retryJob", () => {
  it("requeues a failed job with a clean slate and audits it", async () => {
    const now = new Date("2026-03-01T12:00:00Z");
    const job = await addJob({
      type: "update_limits",
      status: "failed",
      attempts: 3,
      lastError: "agent unreachable",
      result: { x: 1 },
      finishedAt: new Date("2026-03-01T11:00:00Z"),
      runAfter: new Date("2026-03-01T10:00:00Z"),
    });
    await retryJob(t.db, { jobId: job.id, admin: admin(), ip, now });
    const after = await reload(job.id);
    expect(after).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
      result: null,
      finishedAt: null,
    });
    expect(after.runAfter).toEqual(now);
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.targetId, job.id));
    expect(entry).toMatchObject({ action: "job.retry", actorId: adminId, ip });
    expect(entry!.metadata).toMatchObject({
      previousAttempts: 3,
      previousError: "agent unreachable",
    });
  });

  it("refuses when an active job of the same workspace and type exists, leaving the job untouched", async () => {
    const failed = await addJob({
      type: "sync_git",
      status: "failed",
      attempts: 3,
      lastError: "boom",
    });
    await addJob({ type: "sync_git", status: "queued" });
    await expect(retryJob(t.db, { jobId: failed.id, admin: admin(), ip })).rejects.toThrow(
      /already queued/,
    );
    expect(await reload(failed.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "boom",
    });
  });

  it("allows retry when the other active job is a different type or workspace", async () => {
    const other = await newWorkspace(`wsb${randomBytes(2).toString("hex")}`);
    const failed = await addJob({
      type: "stop_workspace",
      status: "failed",
      payload: { reason: "user" },
    });
    await addJob({ type: "start_workspace", status: "running" });
    await addJob({ type: "stop_workspace", status: "queued", workspaceId: other });
    await retryJob(t.db, { jobId: failed.id, admin: admin(), ip });
    expect((await reload(failed.id)).status).toBe("queued");
  });

  it("only retries failed jobs", async () => {
    for (const status of ["queued", "running", "done"] as const) {
      const j = await addJob({ type: "delete_tenant", status, workspaceId: null });
      await expect(retryJob(t.db, { jobId: j.id, admin: admin(), ip })).rejects.toBeInstanceOf(
        UserError,
      );
    }
  });

  it("rejects an unknown job", async () => {
    await expect(
      retryJob(t.db, { jobId: "00000000-0000-0000-0000-000000000000", admin: admin(), ip }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("sends failed image builds back to the Images page", async () => {
    const j = await addJob({
      type: "build_image",
      status: "failed",
      workspaceId: null,
      payload: {},
    });
    await expect(retryJob(t.db, { jobId: j.id, admin: admin(), ip })).rejects.toThrow(
      /Images page/,
    );
  });

  it("refuses a duplicate delete_image for the same image even though the index ignores null workspaces", async () => {
    const payload = { imageRowId: "11111111-1111-1111-1111-111111111111" };
    const failed = await addJob({
      type: "delete_image",
      status: "failed",
      workspaceId: null,
      payload,
    });
    await addJob({ type: "delete_image", status: "queued", workspaceId: null, payload });
    await expect(retryJob(t.db, { jobId: failed.id, admin: admin(), ip })).rejects.toThrow(
      /already has a delete job/,
    );
  });
});

describe("cancelJob", () => {
  it("marks a queued job failed with the admin's email and audits it", async () => {
    const now = new Date("2026-03-02T00:00:00Z");
    const w = await newWorkspace(`wsc${randomBytes(2).toString("hex")}`);
    const j = await addJob({ type: "restart_workspace", status: "queued", workspaceId: w });
    await cancelJob(t.db, { jobId: j.id, admin: admin(), ip, now });
    const after = await reload(j.id);
    expect(after).toMatchObject({ status: "failed", lastError: "Cancelled by admin@example.com" });
    expect(after.finishedAt).toEqual(now);
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.targetId, j.id));
    expect(entry).toMatchObject({ action: "job.cancel", actorId: adminId });
  });

  it("refuses running, done and failed jobs without changing them", async () => {
    const w = await newWorkspace(`wsd${randomBytes(2).toString("hex")}`);
    const running = await addJob({ type: "start_workspace", status: "running", workspaceId: w });
    await expect(cancelJob(t.db, { jobId: running.id, admin: admin(), ip })).rejects.toThrow(
      /already running/,
    );
    expect((await reload(running.id)).status).toBe("running");
    for (const status of ["done", "failed"] as const) {
      const j = await addJob({ type: "delete_tenant", status, workspaceId: null });
      await expect(cancelJob(t.db, { jobId: j.id, admin: admin(), ip })).rejects.toThrow(
        /Only queued/,
      );
    }
  });

  it("fails the building image row when a queued build is cancelled", async () => {
    const [img] = await t.db
      .insert(images)
      .values({ version: nextImageVersion(), t3Ref: "main", status: "building" })
      .returning();
    const j = await addJob({
      type: "build_image",
      status: "queued",
      workspaceId: null,
      payload: { imageRowId: img!.id, t3Ref: "main" },
    });
    await cancelJob(t.db, { jobId: j.id, admin: admin(), ip });
    const row = (await t.db.select().from(images).where(eq(images.id, img!.id)))[0]!;
    expect(row).toMatchObject({ status: "failed", buildLog: "Cancelled by admin@example.com" });
  });
});

describe("listJobs", () => {
  it("filters by status, type and workspace slug and paginates", async () => {
    const slug = `wse${randomBytes(2).toString("hex")}`;
    const w = await newWorkspace(slug);
    await addJob({ type: "fetch_logs", status: "done", workspaceId: w, payload: { tail: 100 } });
    await addJob({ type: "fetch_logs", status: "failed", workspaceId: w, payload: { tail: 100 } });
    await addJob({ type: "inspect_workspace", status: "done", workspaceId: w });
    const all = await listJobs(t.db, { ws: slug, page: 0 });
    expect(all.rows).toHaveLength(3);
    expect(all.rows.every((r) => r.slug === slug)).toBe(true);
    const failedLogs = await listJobs(t.db, {
      ws: slug,
      type: "fetch_logs",
      status: "failed",
      page: 0,
    });
    expect(failedLogs.rows).toHaveLength(1);
    expect((await listJobs(t.db, { ws: "nosuchws", page: 0 })).rows).toHaveLength(0);
    expect((await listJobs(t.db, { page: 99 })).hasNext).toBe(false);
  });
});
