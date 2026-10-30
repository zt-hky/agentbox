import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  images,
  jobs,
  toolLatest,
  toolchainRuns,
  workspaceTools,
  workspaces,
} from "@agentbox/db/schema";
import { requestReconcile } from "@agentbox/db/toolchain";
import type { ToolId } from "@agentbox/core/toolchain";
import { JobRunner } from "../src/jobs.ts";
import { enqueueJob } from "../src/queue.ts";
import { toolchainTuning } from "../src/toolchain.ts";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import {
  IMAGE_ID,
  okToolchainScript,
  startFakeAgent,
  type FakeAgent,
} from "./helpers/fake-agent.ts";
import { seedWorld } from "./helpers/seed.ts";

let t: TestDb;
let agent: FakeAgent;
// DB defaults use the wall clock; keep the injected clock slightly ahead so jobs are due.
const clock = createClock(new Date(Date.now() + 3600_000));

beforeAll(async () => {
  t = await createTestDb();
  agent = await startFakeAgent();
});
afterAll(async () => {
  await agent.close();
  await t.close();
});
beforeEach(async () => {
  clock.set(new Date(Date.now() + 3600_000));
  await resetDb(t.db);
  await t.db.delete(toolLatest);
  agent.calls.length = 0;
  agent.toolchain.script = okToolchainScript;
  agent.toolchain.applies.length = 0;
  agent.toolchain.cancelled.length = 0;
  agent.toolchainState.toolchainAbi = "ubuntu-26.04";
  agent.on("POST /v1/workspaces/alice/start", () => ({
    json: { cgroupPath: "c", startedAt: "now" },
  }));
  toolchainTuning.pollMs = 1;
  toolchainTuning.runTimeoutMs = 30 * 60_000;
});
afterEach(() => {
  toolchainTuning.pollMs = 2000;
  toolchainTuning.runTimeoutMs = 30 * 60_000;
});

const runner = () => new JobRunner(makeCtx(t.db, clock, { socketPath: agent.socketPath }));
async function runAll(r = runner()) {
  const n = await r.tick();
  await r.idle();
  return n;
}
const ws = async (id: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const tool = async (id: string, toolId: ToolId) =>
  (
    await t.db
      .select()
      .from(workspaceTools)
      .where(and(eq(workspaceTools.workspaceId, id), eq(workspaceTools.toolId, toolId)))
  )[0]!;
const runs = (id: string) =>
  t.db.select().from(toolchainRuns).where(eq(toolchainRuns.workspaceId, id));
const jobsOf = (type: (typeof jobs.$inferSelect)["type"]) =>
  t.db.select().from(jobs).where(eq(jobs.type, type));

async function addTool(
  workspaceId: string,
  toolId: ToolId,
  o: Partial<typeof workspaceTools.$inferInsert> = {},
) {
  await t.db.insert(workspaceTools).values({
    workspaceId,
    toolId,
    // Observed: nothing needs inspecting unless a test says so.
    observedAt: new Date(),
    ...o,
  });
}
async function latest(toolId: ToolId, o: Partial<typeof toolLatest.$inferInsert>) {
  await t.db.insert(toolLatest).values({ toolId, versions: [], checkedAt: new Date(), ...o });
}
async function reconcileJob(workspaceId: string) {
  await requestReconcile(t.db, { workspaceId, trigger: "user" });
  await t.db
    .update(jobs)
    .set({ runAfter: clock.now() })
    .where(eq(jobs.type, "reconcile_toolchain"));
}
const toolNames = (applies: { steps: { tool: string }[] }) => applies.steps.map((s) => s.tool);

describe("reconcile_toolchain: plan and version resolution", () => {
  it("installs node lts, the newest 3.12.x for a pinned line, and bun latest; settles rows", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "node", { channel: "lts" });
    await addTool(w.workspaceId, "python", { channel: "pin", pinnedVersion: "3.12" });
    await addTool(w.workspaceId, "bun", { channel: "latest" });
    await latest("node", { latest: "26.13.0", lts: "24.22.2", versions: ["26.13.0", "24.22.2"] });
    await latest("python", {
      latest: "3.13.1",
      versions: ["3.13.1", "3.12.16", "3.12.15", "3.11.9"],
    });
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4", "1.3.3"] });
    await reconcileJob(w.workspaceId);

    await runAll();

    expect(agent.toolchain.applies).toHaveLength(1); // nothing to verify: one agent call
    const [apply] = agent.toolchain.applies;
    expect(apply!.mode).toBe("apply");
    expect(apply!.steps.map((s) => [s.tool, s.action, s.version])).toEqual([
      ["node", "install", "24.22.2"],
      ["bun", "install", "1.3.4"],
      ["python", "install", "3.12.16"],
    ]);
    for (const id of ["node", "python", "bun"] as const) {
      expect(await tool(w.workspaceId, id)).toMatchObject({ state: "idle", lastError: null });
    }
    expect(await tool(w.workspaceId, "python")).toMatchObject({
      installedVersion: "3.12.16",
      backend: "python",
      sizeBytes: 1000,
    });
    const row = await ws(w.workspaceId);
    expect(row.toolchainAppliedGeneration).toBe(row.toolchainGeneration);
    expect(row.toolchainReconciledAt).not.toBeNull();
    expect(row.toolchainAbi).toBe("ubuntu-26.04");
    const [run] = await runs(w.workspaceId);
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(run!.log).toContain("(apply)");
    expect(run!.steps).toHaveLength(3);
    expect((await jobsOf("reconcile_toolchain"))[0]!.status).toBe("done");
  });

  it("verifies image-provided tools first; the external version is observed but stays unmanaged", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "claude", { state: "external", observedAt: null });
    await latest("claude", { latest: "2.2.0", versions: ["2.2.0", "2.1.9"] });
    agent.toolchain.script = async (req) => {
      const reply = await okToolchainScript(req);
      if (req.mode === "check") {
        reply.steps = [
          {
            tool: "claude",
            action: "verify",
            status: "ok",
            observed: "claude 2.1.9 (Claude Code)",
            path: "/opt/x/claude",
          },
        ];
      }
      return reply;
    };
    await reconcileJob(w.workspaceId);

    await runAll();

    expect(agent.toolchain.applies.map((a) => a.mode)).toEqual(["check", "apply"]);
    expect(agent.toolchain.applies[0]!.steps.map((s) => s.action)).toEqual(["verify"]);
    // A managed copy replaces the image's one, but reconcile never upgrades on its own.
    expect(agent.toolchain.applies[1]!.steps[0]).toMatchObject({
      tool: "claude",
      action: "install",
      version: "2.2.0",
    });
    expect(await tool(w.workspaceId, "claude")).toMatchObject({
      state: "idle",
      installedVersion: "2.2.0",
    });
  });

  it("keeps the observed version of an external tool when its install is not planned", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "codex", { state: "external", observedAt: null, desired: false });
    agent.toolchain.script = (req) => ({
      steps: req.steps.map((s) => ({
        tool: s.tool,
        action: s.action,
        status: "ok" as const,
        observed: "codex-cli 0.9.1",
      })),
    });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(await tool(w.workspaceId, "codex")).toMatchObject({
      state: "external",
      installedVersion: "0.9.1",
      backend: null,
    });
    expect(agent.toolchain.applies).toHaveLength(1);
  });

  it("seeds rows from the admin defaults when the workspace has none", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await t.db
      .insert(jobs)
      .values({ type: "reconcile_toolchain", workspaceId: w.workspaceId, runAfter: clock.now() });
    await runAll();
    const rows = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, w.workspaceId));
    expect(rows.map((r) => r.toolId).sort()).toEqual(
      ["bun", "claude", "codex", "node", "omp", "python"].sort(),
    );
    // Image-provided defaults are inspected first.
    expect(agent.toolchain.applies[0]!.mode).toBe("check");
  });
});

describe("reconcile_toolchain: failures keep the old install", () => {
  it("rolls back semantics: a failed upgrade keeps the installed version, run is partial", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun", {
      state: "idle",
      installedVersion: "1.3.0",
      previousVersion: "1.2.0",
      backend: "bun",
      requestedAction: "upgrade",
    });
    await addTool(w.workspaceId, "python", { channel: "latest" });
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4", "1.3.0"] });
    await latest("python", { latest: "3.13.1", versions: ["3.13.1"] });
    agent.toolchain.script = (req) => ({
      steps: req.steps.map((s) =>
        s.tool === "bun"
          ? {
              tool: s.tool,
              action: s.action,
              status: "failed" as const,
              errorCode: "smoke_failed" as const,
              error: "bun --version exited 1",
            }
          : { tool: s.tool, action: s.action, status: "ok" as const, version: s.version },
      ),
    });
    await reconcileJob(w.workspaceId);

    await runAll();

    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "failed",
      installedVersion: "1.3.0",
      previousVersion: "1.2.0",
      backend: "bun",
      lastError: "smoke_failed: bun --version exited 1",
      requestedAction: null,
    });
    expect(await tool(w.workspaceId, "python")).toMatchObject({
      state: "idle",
      installedVersion: "3.13.1",
    });
    const [run] = await runs(w.workspaceId);
    expect(run!.status).toBe("partial");
    expect(run!.error).toContain("bun: smoke_failed");
    expect((await ws(w.workspaceId)).toolchainReconciledAt).toBeNull();
  });

  it("an ok upgrade records the previous version and clears the request", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun", {
      state: "idle",
      installedVersion: "1.3.0",
      backend: "bun",
      requestedAction: "upgrade",
    });
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4", "1.3.0"] });
    agent.toolchain.script = (req) => ({
      steps: req.steps.map((s) => ({
        tool: s.tool,
        action: s.action,
        status: "ok" as const,
        version: s.version,
        previous: "1.3.0",
        backend: "bun",
      })),
    });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(agent.toolchain.applies[0]!.steps[0]).toMatchObject({
      action: "install",
      version: "1.3.4",
    });
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "idle",
      installedVersion: "1.3.4",
      previousVersion: "1.3.0",
      requestedAction: null,
    });
  });

  it("a rollback relinks to the previous version", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun", {
      state: "idle",
      installedVersion: "1.3.4",
      previousVersion: "1.3.0",
      backend: "bun",
      requestedAction: "rollback",
    });
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4", "1.3.0"] });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(agent.toolchain.applies[0]!.steps[0]).toMatchObject({
      action: "relink",
      version: "1.3.0",
    });
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      installedVersion: "1.3.0",
      requestedAction: null,
    });
  });

  it("removes a tool switched off", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun", {
      state: "idle",
      installedVersion: "1.3.0",
      previousVersion: "1.2.0",
      backend: "bun",
      desired: false,
    });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(agent.toolchain.applies[0]!.steps[0]).toMatchObject({ tool: "bun", action: "remove" });
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "idle",
      installedVersion: null,
      previousVersion: null,
      backend: null,
    });
    expect((await runs(w.workspaceId))[0]!.status).toBe("succeeded");
  });

  it("a desired tool with no published version fails with the planner's reason", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun");
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(agent.toolchain.applies).toHaveLength(0);
    expect(await tool(w.workspaceId, "bun")).toMatchObject({ state: "failed" });
    expect((await tool(w.workspaceId, "bun")).lastError).toMatch(/no published versions/);
    expect((await runs(w.workspaceId))[0]!.status).toBe("failed");
  });

  it("agent 422 (no mise) fails the run with the agent's message and does not retry", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun");
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4"] });
    agent.toolchain.script = () => ({ applyStatus: 422, applyError: "image has no mise" });
    await reconcileJob(w.workspaceId);
    await runAll();
    const [run] = await runs(w.workspaceId);
    expect(run).toMatchObject({ status: "failed", error: "image has no mise" });
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "failed",
      lastError: "image has no mise",
    });
    expect((await jobsOf("reconcile_toolchain"))[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });

  it("agent 507 (quota) fails the run with the plain message", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun");
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4"] });
    agent.toolchain.script = () => ({ applyStatus: 507, applyError: "disk quota exceeded" });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect((await runs(w.workspaceId))[0]).toMatchObject({
      status: "failed",
      error: "disk quota exceeded",
    });
  });

  it("cancels an agent run that exceeds the timeout", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun");
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4"] });
    toolchainTuning.runTimeoutMs = 30;
    agent.toolchain.script = () => ({ state: "running", log: "installing\n", steps: [] });
    await reconcileJob(w.workspaceId);
    await runAll();
    expect(agent.toolchain.cancelled).toHaveLength(1);
    const [run] = await runs(w.workspaceId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toMatch(/timed out/);
    expect(run!.log).toBe("installing\n");
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "failed",
      lastError: "timed out",
    });
  });
});

describe("reconcile_toolchain: interruption", () => {
  async function interruptedSetup(attempts = 0) {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "bun");
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4"] });
    await reconcileJob(w.workspaceId);
    await t.db
      .update(toolchainRuns)
      .set({ attempts })
      .where(eq(toolchainRuns.workspaceId, w.workspaceId));
    return w;
  }

  it("agent state `interrupted` leaves the run interrupted and the workspace pending", async () => {
    const w = await interruptedSetup();
    agent.toolchain.script = () => ({ state: "interrupted", log: "partial\n" });
    await runAll();
    const [run] = await runs(w.workspaceId);
    expect(run).toMatchObject({ status: "interrupted", attempts: 1 });
    expect(run!.log).toBe("partial\n");
    expect((await ws(w.workspaceId)).toolchainPending).toBe(true);
    expect(await tool(w.workspaceId, "bun")).toMatchObject({ state: "pending" });
    expect((await jobsOf("reconcile_toolchain"))[0]!.status).toBe("done");
  });

  it("agent 409 on apply is an interruption too", async () => {
    const w = await interruptedSetup();
    agent.toolchain.script = () => ({ applyStatus: 409, applyError: "workspace is not running" });
    await runAll();
    expect((await runs(w.workspaceId))[0]).toMatchObject({ status: "interrupted", attempts: 1 });
    expect((await ws(w.workspaceId)).toolchainPending).toBe(true);
  });

  it("gives up after 3 interruptions", async () => {
    const w = await interruptedSetup(2);
    agent.toolchain.script = () => ({ state: "interrupted" });
    await runAll();
    const [run] = await runs(w.workspaceId);
    expect(run).toMatchObject({ status: "failed", attempts: 3 });
    expect(run!.error).toMatch(/interrupted 3 times/);
    expect((await ws(w.workspaceId)).toolchainPending).toBe(false);
  });

  it("the next start resumes an interrupted run on a new run that carries the attempts", async () => {
    const w = await interruptedSetup();
    agent.toolchain.script = () => ({ state: "interrupted" });
    await runAll();
    agent.toolchain.script = okToolchainScript;
    // The container comes back: the start hook enqueues a reconcile for the pending workspace.
    await t.db
      .update(workspaces)
      .set({ status: "sleeping" })
      .where(eq(workspaces.id, w.workspaceId));
    await t.db
      .insert(images)
      .values({ imageId: IMAGE_ID, rootfsPath: "/r", t3Ref: "m", status: "active" });
    await enqueueJob(t.db, { type: "start_workspace", workspaceId: w.workspaceId });
    await t.db.update(jobs).set({ runAfter: clock.now() });
    await runAll(); // start (+ hook)
    await t.db.update(jobs).set({ runAfter: clock.now() });
    await runAll(); // reconcile
    const all = await runs(w.workspaceId);
    expect(all.filter((r) => r.status === "succeeded")).toHaveLength(1);
    expect((await ws(w.workspaceId)).toolchainPending).toBe(false);
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "idle",
      installedVersion: "1.3.4",
    });
  });
});

describe("reconcile_toolchain: drain", () => {
  it("applies a change that arrived during the run before finishing", async () => {
    const w = await seedWorld(t.db, { status: "running" });
    await addTool(w.workspaceId, "node", { channel: "lts" });
    await addTool(w.workspaceId, "codex", {
      state: "idle",
      installedVersion: "0.9.0",
      backend: "aqua:openai/codex",
    });
    await latest("node", { latest: "26.13.0", lts: "24.22.2", versions: ["26.13.0", "24.22.2"] });
    await latest("codex", { latest: "0.9.0", versions: ["0.9.0"] });
    let first = true;
    agent.toolchain.script = async (req) => {
      if (first) {
        first = false;
        // The user asks for a reinstall while the first pass is running.
        await requestReconcile(t.db, {
          workspaceId: w.workspaceId,
          trigger: "user",
          changes: [{ toolId: "codex", action: "reinstall" }],
        });
      }
      return okToolchainScript(req);
    };
    await reconcileJob(w.workspaceId);

    await runAll();

    expect(agent.toolchain.applies.map(toolNames)).toEqual([["node"], ["codex"]]);
    const row = await ws(w.workspaceId);
    expect(row.toolchainGeneration).toBe(2);
    expect(row.toolchainAppliedGeneration).toBe(2);
    const all = await runs(w.workspaceId);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("succeeded");
    expect(all[0]!.steps).toHaveLength(2);
    expect(await jobsOf("reconcile_toolchain")).toHaveLength(1);
  });
});

describe("reconcile_toolchain: auto-start", () => {
  const manifest = {
    mise: "2026.10.23",
    toolchainAbi: "ubuntu-26.04",
    envVersion: 1,
    slim: false,
    baked: [],
  };

  it("starts a sleeping workspace, then the start hook resumes the same run", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    await t.db
      .insert(images)
      .values({ imageId: IMAGE_ID, rootfsPath: "/r", t3Ref: "m", status: "active", manifest });
    await addTool(w.workspaceId, "bun");
    await latest("bun", { latest: "1.3.4", versions: ["1.3.4"] });
    const { runId } = await requestReconcile(t.db, { workspaceId: w.workspaceId, trigger: "user" });
    await t.db.update(jobs).set({ runAfter: clock.now() });

    await runAll(); // reconcile on a sleeping workspace

    let row = await ws(w.workspaceId);
    expect(row.toolchainPending).toBe(true);
    expect((await runs(w.workspaceId))[0]).toMatchObject({ id: runId, status: "waiting" });
    const starts = await jobsOf("start_workspace");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.status).toBe("queued");
    expect(agent.toolchain.applies).toHaveLength(0);

    await t.db.update(jobs).set({ runAfter: clock.now() });
    await runAll(); // start_workspace
    row = await ws(w.workspaceId);
    expect(row.status).toBe("running");
    expect(row.toolchainPending).toBe(false);
    const queued = (await jobsOf("reconcile_toolchain")).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);

    await t.db.update(jobs).set({ runAfter: clock.now() });
    await runAll(); // reconcile on a running workspace
    const all = await runs(w.workspaceId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: runId, status: "succeeded" });
    expect(await tool(w.workspaceId, "bun")).toMatchObject({
      state: "idle",
      installedVersion: "1.3.4",
    });
  });

  it("the billing gate blocks the start with a plain reason", async () => {
    const w = await seedWorld(t.db, {
      status: "sleeping",
      subscription: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    await addTool(w.workspaceId, "bun");
    await requestReconcile(t.db, { workspaceId: w.workspaceId, trigger: "user" });
    await t.db.update(jobs).set({ runAfter: clock.now() });

    await runAll();

    const [run] = await runs(w.workspaceId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe(
      "The workspace could not be started to apply the toolchain: the free trial has ended.",
    );
    expect(await jobsOf("start_workspace")).toHaveLength(0);
    expect((await ws(w.workspaceId)).toolchainPending).toBe(false);
  });

  it("an errored workspace is started the same way", async () => {
    const w = await seedWorld(t.db, { status: "error" });
    await addTool(w.workspaceId, "bun");
    await requestReconcile(t.db, { workspaceId: w.workspaceId, trigger: "user" });
    await t.db.update(jobs).set({ runAfter: clock.now() });
    await runAll();
    expect(await jobsOf("start_workspace")).toHaveLength(1);
    expect((await runs(w.workspaceId))[0]!.status).toBe("waiting");
  });

  it("starting/stopping workspaces make the runner retry; provisioning is final", async () => {
    const a = await seedWorld(t.db, { slug: "alice", slot: 1, status: "starting" });
    const b = await seedWorld(t.db, { slug: "bob", slot: 2, status: "provisioning" });
    for (const w of [a, b]) {
      await t.db
        .insert(jobs)
        .values({ type: "reconcile_toolchain", workspaceId: w.workspaceId, runAfter: clock.now() });
    }
    await runAll(runner());
    const byWs = new Map((await jobsOf("reconcile_toolchain")).map((j) => [j.workspaceId, j]));
    expect(byWs.get(a.workspaceId)).toMatchObject({ status: "queued", attempts: 1 });
    expect(byWs.get(b.workspaceId)!.status).toBe("failed");
  });

  it("a gone workspace is a no-op", async () => {
    const w = await seedWorld(t.db, { status: "deleted" });
    await t.db
      .insert(jobs)
      .values({ type: "reconcile_toolchain", workspaceId: w.workspaceId, runAfter: clock.now() });
    await runAll();
    expect((await jobsOf("reconcile_toolchain"))[0]!.status).toBe("done");
    expect(agent.toolchain.applies).toHaveLength(0);
  });
});

describe("start hook", () => {
  async function startOnce(manifest: unknown, ws0: Partial<typeof workspaces.$inferInsert> = {}) {
    const w = await seedWorld(t.db, { status: "sleeping", workspace: ws0 });
    await t.db
      .insert(images)
      .values({ imageId: IMAGE_ID, rootfsPath: "/r", t3Ref: "m", status: "active", manifest });
    await t.db
      .insert(jobs)
      .values({ type: "start_workspace", workspaceId: w.workspaceId, runAfter: clock.now() });
    await runAll();
    return w;
  }
  const mise = { mise: "1", toolchainAbi: null, envVersion: 1, slim: false, baked: [] };

  it("reconciles a never-reconciled workspace when the image ships mise", async () => {
    const w = await startOnce(mise);
    expect((await ws(w.workspaceId)).status).toBe("running");
    expect(await jobsOf("reconcile_toolchain")).toHaveLength(1);
    expect((await runs(w.workspaceId))[0]!.trigger).toBe("defaults");
  });

  it("does nothing for an image without mise or manifest", async () => {
    await startOnce({ ...mise, mise: null });
    expect(await jobsOf("reconcile_toolchain")).toHaveLength(0);
  });

  it("does nothing for an already reconciled workspace", async () => {
    await startOnce(mise, { toolchainReconciledAt: new Date() });
    expect(await jobsOf("reconcile_toolchain")).toHaveLength(0);
  });

  it("never fails the start when the hook breaks", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    await t.db.insert(images).values({
      imageId: IMAGE_ID,
      rootfsPath: "/r",
      t3Ref: "m",
      status: "active",
      manifest: mise,
    });
    await t.db
      .insert(jobs)
      .values({ type: "start_workspace", workspaceId: w.workspaceId, runAfter: clock.now() });
    // requestReconcile inserts into toolchain_runs: make that fail.
    await t.db.execute(sql`alter table toolchain_runs rename to toolchain_runs_off`);
    try {
      await runAll();
    } finally {
      await t.db.execute(sql`alter table toolchain_runs_off rename to toolchain_runs`);
    }
    expect((await ws(w.workspaceId)).status).toBe("running");
    expect((await jobsOf("start_workspace"))[0]!.status).toBe("done");
  });
});
