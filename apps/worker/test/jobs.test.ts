import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { encrypt } from "@agentbox/core";
import {
  githubConnections,
  images,
  jobs,
  workspaceEvents,
  workspaceSessions,
  workspaces,
} from "@agentbox/db/schema";
import { JobRunner } from "../src/jobs.ts";
import { enqueueJob } from "../src/queue.ts";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { IMAGE_ID, startFakeAgent, type FakeAgent } from "./helpers/fake-agent.ts";
import { ENC_KEY, seedWorld } from "./helpers/seed.ts";

let t: TestDb;
let agent: FakeAgent;
const clock = createClock();

beforeAll(async () => {
  t = await createTestDb();
  agent = await startFakeAgent();
});
afterAll(async () => {
  await agent.close();
  await t.close();
});
beforeEach(async () => {
  clock.set(new Date("2026-03-10T12:00:00.000Z"));
  await resetDb(t.db);
  agent.calls.length = 0;
  for (const r of [
    "POST /v1/workspaces/alice/start",
    "POST /v1/workspaces/alice/github",
    "DELETE /v1/images/" + IMAGE_ID,
  ]) {
    agent.on(r, () => ({
      json: r.includes("start") ? { cgroupPath: "c", startedAt: "now" } : { ok: true },
    }));
  }
  agent.on("POST /v1/images/build", () => ({
    json: {
      imageId: IMAGE_ID,
      scanSummary: {
        counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
        fixableCritical: 0,
      },
      logPath: "/x",
    },
  }));
});

const runner = () => new JobRunner(makeCtx(t.db, clock, { socketPath: agent.socketPath }));
async function runAll(r = runner()) {
  const n = await r.tick();
  await r.idle();
  return n;
}
const job = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const ws = async (id: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const events = (id: string) =>
  t.db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, id));
async function enqueue(
  type: Parameters<typeof enqueueJob>[1]["type"],
  workspaceId: string | null,
  payload: unknown = {},
) {
  await enqueueJob(t.db, { type, workspaceId, payload });
  // DB defaults use the wall clock; make the job due on the injected clock.
  await t.db.update(jobs).set({ runAfter: clock.now() }).where(eq(jobs.type, type));
  const [j] = await t.db.select().from(jobs).where(eq(jobs.type, type));
  return j!.id;
}
async function activeImage() {
  await t.db
    .insert(images)
    .values({ imageId: IMAGE_ID, rootfsPath: "/r", t3Ref: "main", status: "active" });
}

describe("job runner: retry and backoff", () => {
  it("retries with 2^attempts*5s backoff and fails after 3 attempts", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    const id = await enqueue("start_workspace", w.workspaceId); // no active image → handler throws

    expect(await runAll()).toBe(1);
    let j = await job(id);
    expect(j).toMatchObject({ status: "queued", attempts: 1 });
    expect(j.lastError).toMatch(/no active workspace image/);
    expect(j.runAfter.getTime()).toBe(clock.now().getTime() + 10_000);

    clock.advance(9_999);
    expect(await runAll()).toBe(0); // not due yet
    clock.advance(1);
    expect(await runAll()).toBe(1);
    j = await job(id);
    expect(j).toMatchObject({ status: "queued", attempts: 2 });
    expect(j.runAfter.getTime()).toBe(clock.now().getTime() + 20_000);

    clock.advance(20_000);
    expect(await runAll()).toBe(1);
    j = await job(id);
    expect(j).toMatchObject({ status: "failed", attempts: 3 });
    expect(j.lastError).toMatch(/no active workspace image/);
    clock.advance(10 * 3600_000);
    expect(await runAll()).toBe(0);

    const row = await ws(w.workspaceId);
    expect(row).toMatchObject({ status: "error", startFailures: 3 });
    expect((await events(w.workspaceId)).filter((e) => e.type === "start_failed")).toHaveLength(3);
  });

  it("claims at most one job per workspace and respects the concurrency limit", async () => {
    const a = await seedWorld(t.db, { slug: "alice", slot: 1, status: "running" });
    await enqueue("stop_workspace", a.workspaceId, { reason: "user" });
    await enqueue("update_limits", a.workspaceId);
    expect(await runner().claim(4)).toHaveLength(1);
    // The claimed one is now `running`; the other must wait for it.
    expect(await runner().claim(4)).toHaveLength(0);

    await resetDb(t.db);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const w = await seedWorld(t.db, { slug: `user${i}x`, slot: i + 1 });
      ids.push(w.workspaceId);
      await enqueueJob(t.db, { type: "update_limits", workspaceId: w.workspaceId });
    }
    await t.db.update(jobs).set({ runAfter: clock.now() });
    expect(await runner().claim(4)).toHaveLength(4);
  });

  it("requeues jobs left running by a crashed worker", async () => {
    const w = await seedWorld(t.db);
    const id = await enqueue("update_limits", w.workspaceId);
    await t.db.update(jobs).set({ status: "running" });
    expect(await runner().recoverRunning()).toBe(1);
    expect((await job(id)).status).toBe("queued");
  });
});

describe("job handlers", () => {
  it("provision_tenant creates the tenant with plan limits and goes to sleeping", async () => {
    const w = await seedWorld(t.db, { status: "provisioning", slot: 7 });
    const id = await enqueue("provision_tenant", w.workspaceId);
    await runAll();
    expect((await job(id)).status).toBe("done");
    expect((await ws(w.workspaceId)).status).toBe("sleeping");
    expect(agent.callsTo("POST /v1/tenants")[0]!.body).toEqual({
      ws: "alice",
      slot: 7,
      diskGb: 5,
      limits: { cpus: 1, memoryMb: 2048, pidsLimit: 512, inodes: 500000 },
    });
  });

  it("start_workspace passes image, plan limits and decrypted identity env, then reconciles GitHub", async () => {
    await activeImage();
    const w = await seedWorld(t.db, {
      status: "sleeping",
      workspace: { githubSyncPending: true, startFailures: 2 },
    });
    await t.db.insert(githubConnections).values({
      userId: w.userId,
      login: "octo",
      githubId: 42n,
      tokenEnc: encrypt("gho_secret", ENC_KEY),
    });
    const id = await enqueue("start_workspace", w.workspaceId);
    await runAll();
    expect((await job(id)).status).toBe("done");
    const body = agent.callsTo("POST /v1/workspaces/alice/start")[0]!.body;
    expect(body).toEqual({
      imageId: IMAGE_ID,
      slot: 1,
      limits: { cpus: 1, memoryMb: 2048, pidsLimit: 512, inodes: 500000 },
      env: {
        T3CODE_GATEWAY_IDENTITY_SECRET: w.secret,
        T3CODE_GATEWAY_IDENTITY_AUDIENCE: "alice",
        T3CODE_INSTANCE_NAME: "alice",
        T3CODE_VSCODE_WEB_URL: "https://alice-code.agentbox.io.vn",
      },
    });
    const row = await ws(w.workspaceId);
    expect(row).toMatchObject({
      status: "running",
      imageId: IMAGE_ID,
      startFailures: 0,
      githubSyncPending: false,
    });
    expect(row.awakeSince!.getTime()).toBe(clock.now().getTime());
    expect(row.lastActivityAt!.getTime()).toBe(clock.now().getTime());
    expect((await events(w.workspaceId)).map((e) => e.type)).toEqual(["started"]);
    expect(agent.callsTo("POST /v1/workspaces/alice/github")[0]!.body).toEqual({
      token: "gho_secret",
      login: "octo",
      email: "42+octo@users.noreply.github.com",
    });
  });

  it("stop_workspace records the reason and clears awakeSince", async () => {
    const w = await seedWorld(t.db, { workspace: { awakeSince: clock.now() } });
    await enqueue("stop_workspace", w.workspaceId, { reason: "idle" });
    await runAll();
    expect(await ws(w.workspaceId)).toMatchObject({ status: "sleeping", awakeSince: null });
    const [e] = await events(w.workspaceId);
    expect(e).toMatchObject({ type: "stopped", details: { reason: "idle" } });
    expect(agent.callsTo("POST /v1/workspaces/alice/stop")).toHaveLength(1);
  });

  it.each(["daily_limit", "trial_ended"])("stop_workspace accepts reason %s", async (reason) => {
    const w = await seedWorld(t.db, { workspace: { awakeSince: clock.now() } });
    const id = await enqueue("stop_workspace", w.workspaceId, { reason });
    await runAll();
    expect((await job(id)).status).toBe("done");
    expect((await events(w.workspaceId))[0]).toMatchObject({
      type: "stopped",
      details: { reason },
    });
  });

  it("stop_workspace with a failing agent leaves the workspace in error and retries", async () => {
    const w = await seedWorld(t.db);
    agent.on("POST /v1/workspaces/alice/stop", {
      status: 500,
      json: { error: "podman stop failed" },
    });
    const id = await enqueue("stop_workspace", w.workspaceId, { reason: "user" });
    await runAll();
    expect(await ws(w.workspaceId)).toMatchObject({ status: "error" });
    expect(await job(id)).toMatchObject({ status: "queued", lastError: "podman stop failed" });
    agent.on("POST /v1/workspaces/alice/stop", { json: { ok: true } });
    clock.advance(10_000);
    await runAll();
    expect((await ws(w.workspaceId)).status).toBe("sleeping");
  });

  it("restart_workspace stops then starts and records stopped(restart) before started", async () => {
    await activeImage();
    const w = await seedWorld(t.db, { workspace: { awakeSince: clock.now() } });
    const id = await enqueue("restart_workspace", w.workspaceId);
    await runAll();
    expect(await ws(w.workspaceId)).toMatchObject({ status: "running", imageId: IMAGE_ID });
    const types = (await events(w.workspaceId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => [e.type, e.details]);
    expect(types).toEqual([
      ["stopped", { reason: "restart" }],
      ["started", { imageId: IMAGE_ID }],
    ]);
    const order = agent.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("POST /v1/workspaces/alice/stop")).toBeLessThan(
      order.indexOf("POST /v1/workspaces/alice/start"),
    );
    expect(await job(id)).toMatchObject({ status: "done" });
  });

  it("restart_workspace on a sleeping workspace only starts it", async () => {
    await activeImage();
    const w = await seedWorld(t.db, { status: "sleeping" });
    await enqueue("restart_workspace", w.workspaceId);
    await runAll();
    expect(agent.callsTo("POST /v1/workspaces/alice/stop")).toHaveLength(0);
    expect((await ws(w.workspaceId)).status).toBe("running");
  });

  it("fetch_logs asks the agent for the payload's tail and stores {log, fetchedAt}", async () => {
    const w = await seedWorld(t.db);
    agent.on("GET /v1/workspaces/alice/logs", { json: { log: "line1\nline2" } });
    const id = await enqueue("fetch_logs", w.workspaceId, { tail: 500 });
    await runAll();
    expect(agent.callsTo("GET /v1/workspaces/alice/logs")[0]?.query).toBe("?tail=500");
    expect(await job(id)).toMatchObject({
      status: "done",
      result: { log: "line1\nline2", fetchedAt: clock.now().toISOString() },
      finishedAt: clock.now(),
    });
  });

  it("inspect_workspace stores the process list", async () => {
    const w = await seedWorld(t.db);
    const processes = [
      { pid: 1, user: "kyle", cpu: 0, mem: 0.1, elapsed: "00:46", command: "init" },
    ];
    agent.on("GET /v1/workspaces/alice/top", {
      json: { startedAt: "2026-03-10T11:00:00.000Z", processes },
    });
    const id = await enqueue("inspect_workspace", w.workspaceId);
    await runAll();
    expect((await job(id)).result).toEqual({
      running: true,
      startedAt: "2026-03-10T11:00:00.000Z",
      processes,
      fetchedAt: clock.now().toISOString(),
    });
  });

  it("diagnostic jobs fail fast without retry when the workspace is not running", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    const id = await enqueue("inspect_workspace", w.workspaceId);
    await runAll();
    expect(await job(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: expect.stringMatching(/not running/),
      finishedAt: clock.now(),
    });
    expect(agent.callsTo("GET /v1/workspaces/alice/top")).toHaveLength(0);
  });

  it("diagnostic jobs are not retried when the agent reports 409 or fails", async () => {
    const w = await seedWorld(t.db);
    agent.on("GET /v1/workspaces/alice/logs", {
      status: 409,
      json: { error: "workspace alice is not running" },
    });
    const id = await enqueue("fetch_logs", w.workspaceId, { tail: 100 });
    await runAll();
    expect(await job(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "workspace alice is not running",
      result: null,
    });
  });

  it("sets finishedAt on done and final failure, not on a requeue", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    const failing = await enqueue("start_workspace", w.workspaceId); // no active image
    await runAll();
    expect((await job(failing)).finishedAt).toBeNull();
    const w2 = await seedWorld(t.db, { slug: "bobby", slot: 2 });
    const ok = await enqueue("update_limits", w2.workspaceId);
    await runAll();
    expect((await job(ok)).finishedAt).toEqual(clock.now());
  });

  it("delete_tenant deletes via the agent, marks deleted and revokes sessions", async () => {
    const w = await seedWorld(t.db, { status: "deleting" });
    await t.db.insert(workspaceSessions).values({
      tokenHash: "h",
      userId: w.userId,
      workspaceId: w.workspaceId,
      host: "alice-t3.agentbox.io.vn",
      expiresAt: new Date(clock.now().getTime() + 1000),
    });
    await enqueue("delete_tenant", w.workspaceId);
    await runAll();
    expect((await ws(w.workspaceId)).status).toBe("deleted");
    expect(agent.callsTo("DELETE /v1/tenants/alice")).toHaveLength(1);
    expect((await t.db.select().from(workspaceSessions))[0]!.revokedAt).not.toBeNull();
  });

  it("sync_github: sleeping sets the pending flag; running connects or disconnects; 409 stays pending", async () => {
    const sleeping = await seedWorld(t.db, { status: "sleeping" });
    await enqueue("sync_github", sleeping.workspaceId);
    await runAll();
    expect((await ws(sleeping.workspaceId)).githubSyncPending).toBe(true);
    expect(agent.calls).toHaveLength(0);

    await t.db.update(workspaces).set({ status: "running" });
    await t.db.delete(jobs);
    await enqueue("sync_github", sleeping.workspaceId);
    await runAll();
    expect(agent.callsTo("DELETE /v1/workspaces/alice/github")).toHaveLength(1);
    expect((await ws(sleeping.workspaceId)).githubSyncPending).toBe(false);

    await t.db.insert(githubConnections).values({
      userId: sleeping.userId,
      login: "octo",
      githubId: 1n,
      tokenEnc: encrypt("tok", ENC_KEY),
    });
    agent.on("POST /v1/workspaces/alice/github", {
      status: 409,
      json: { error: "container not running" },
    });
    await t.db.delete(jobs);
    const id = await enqueue("sync_github", sleeping.workspaceId);
    await runAll();
    expect((await job(id)).status).toBe("done");
    expect((await ws(sleeping.workspaceId)).githubSyncPending).toBe(true);
  });

  it("update_limits PUTs plan limits", async () => {
    const w = await seedWorld(t.db, { plan: "Pro" });
    await enqueue("update_limits", w.workspaceId);
    await runAll();
    expect(agent.callsTo("PUT /v1/tenants/alice/limits")[0]!.body).toEqual({
      diskGb: 20,
      limits: { cpus: 2, memoryMb: 4096, pidsLimit: 2048, inodes: 2000000 },
    });
  });

  it("update_limits for Max sends 4 vCPU / 8 GB / 50 GB / 4M inodes / 4096 pids", async () => {
    const w = await seedWorld(t.db, { planId: "00000000-0000-4000-8000-0000000000a4" });
    await enqueue("update_limits", w.workspaceId);
    await runAll();
    expect(agent.callsTo("PUT /v1/tenants/alice/limits")[0]!.body).toEqual({
      diskGb: 50,
      limits: { cpus: 4, memoryMb: 8192, pidsLimit: 4096, inodes: 4000000 },
    });
  });

  it("build_image fills imageId/rootfsPath/scanSummary/log on success", async () => {
    const [row] = await t.db
      .insert(images)
      .values({ t3Ref: "omp-overlay", status: "building" })
      .returning();
    const id = await enqueue("build_image", null, { imageRowId: row!.id, t3Ref: "omp-overlay" });
    await runAll();
    const call = agent.callsTo("POST /v1/images/build")[0]!;
    expect(call.body).toEqual({ jobId: id, t3Ref: "omp-overlay" });
    const [img] = await t.db.select().from(images).where(eq(images.id, row!.id));
    expect(img).toMatchObject({
      status: "ready",
      imageId: IMAGE_ID,
      rootfsPath: `/srv/agentbox/rootfs/${IMAGE_ID}`,
      buildLog: "step 1\nstep 2",
      scanSummary: {
        counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
        fixableCritical: 0,
      },
    });
    expect(agent.callsTo(`GET /v1/images/build/${id}/log`)[0]!.query).toBe("?tail=200");
  });

  it("build_image failure marks the row failed with the log tail and is not retried", async () => {
    const [row] = await t.db
      .insert(images)
      .values({ t3Ref: "main", status: "building" })
      .returning();
    agent.on("POST /v1/images/build", {
      status: 500,
      json: { error: "trivy found fixable CRITICAL" },
    });
    const id = await enqueue("build_image", null, { imageRowId: row!.id, t3Ref: "main" });
    await runAll();
    expect(await job(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "trivy found fixable CRITICAL",
    });
    const [img] = await t.db.select().from(images).where(eq(images.id, row!.id));
    expect(img).toMatchObject({ status: "failed", buildLog: "step 1\nstep 2", imageId: null });
  });

  it("delete_image removes via the agent and retires the row; refuses the active image", async () => {
    const [row] = await t.db
      .insert(images)
      .values({ imageId: IMAGE_ID, rootfsPath: "/r", t3Ref: "main", status: "ready" })
      .returning();
    await enqueue("delete_image", null, { imageRowId: row!.id });
    await runAll();
    expect(agent.callsTo(`DELETE /v1/images/${IMAGE_ID}`)).toHaveLength(1);
    expect((await t.db.select().from(images))[0]!.status).toBe("retired");

    await t.db.update(images).set({ status: "active" });
    await t.db.delete(jobs);
    agent.calls.length = 0;
    const id = await enqueue("delete_image", null, { imageRowId: row!.id });
    await runAll();
    expect(await job(id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(agent.calls).toHaveLength(0);
    expect((await t.db.select().from(images))[0]!.status).toBe("active");
  });
});
