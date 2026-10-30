import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COPILOT_INTEGRATION_STATUSES, type CopilotLoginState } from "@agentbox/core/accounts";
import { jobs, workspaceIntegrations, workspaces } from "@agentbox/db/schema";
import { pollCopilotLogins, reconcileCopilot, startCopilotLogin } from "../src/accounts.ts";
import { JobRunner, reconcileGithub } from "../src/jobs.ts";
import { enqueueJob } from "../src/queue.ts";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { startFakeAgent, type FakeAgent } from "./helpers/fake-agent.ts";
import { seedWorld } from "./helpers/seed.ts";

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

const LOGIN = "/v1/workspaces/alice/copilot/login";
const state = (over: Partial<CopilotLoginState> = {}): CopilotLoginState => ({
  status: "idle",
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  error: null,
  ...over,
});
const CODE = state({
  status: "code",
  userCode: "9B0A-2584",
  verificationUri: "https://github.com/login/device",
  expiresAt: "2026-03-10T12:15:00.000Z",
});

beforeEach(async () => {
  clock.set(new Date("2026-03-10T12:00:00.000Z"));
  await resetDb(t.db);
  agent.calls.length = 0;
  agent.on(`POST ${LOGIN}`, { json: state({ status: "starting" }) });
  agent.on(`GET ${LOGIN}`, { json: state({ status: "starting" }) });
  agent.on(`DELETE ${LOGIN}`, { json: { ok: true } });
  agent.on("DELETE /v1/workspaces/alice/copilot", { json: { ok: true } });
  agent.on("PUT /v1/workspaces/alice/copilot/provider", { json: { ok: true } });
});

const ctx = () => makeCtx(t.db, clock, { socketPath: agent.socketPath });
const row = async (workspaceId: string) =>
  (
    await t.db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.workspaceId, workspaceId))
  )[0];
const ws = async (id: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const seedRow = (
  workspaceId: string,
  status: (typeof workspaceIntegrations.$inferInsert)["status"],
  detail: Record<string, unknown> = {},
  observedAt = clock.now(),
) =>
  t.db
    .insert(workspaceIntegrations)
    .values({ workspaceId, kind: "copilot", status, detail, observedAt });

describe("schema and contract", () => {
  it("core's integration statuses equal the DB enum", () => {
    expect([...COPILOT_INTEGRATION_STATUSES]).toEqual([
      ...(workspaceIntegrations.status.enumValues as string[]),
    ]);
  });
});

describe("copilot sign-in state machine (worker)", () => {
  it("copilot_login job starts the session and records the first state", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "starting");
    await enqueueJob(t.db, { type: "copilot_login", workspaceId: w.workspaceId });
    await t.db.update(jobs).set({ runAfter: clock.now() });
    const r = new JobRunner(ctx());
    await r.tick();
    await r.idle();
    expect(agent.callsTo(`POST ${LOGIN}`)).toHaveLength(1);
    expect((await row(w.workspaceId))!.status).toBe("starting");
    const [j] = await t.db.select().from(jobs);
    expect(j!.status).toBe("done");
  });

  it("starting -> code -> signed_in; sign-in seeds the T3 provider once", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "starting");
    agent.on(`GET ${LOGIN}`, { json: CODE });
    await pollCopilotLogins(ctx());
    const code = (await row(w.workspaceId))!;
    expect(code.status).toBe("code");
    expect(code.detail).toEqual({
      userCode: "9B0A-2584",
      verificationUri: "https://github.com/login/device",
      expiresAt: "2026-03-10T12:15:00.000Z",
    });
    expect(agent.callsTo("PUT /v1/workspaces/alice/copilot/provider")).toHaveLength(0);

    agent.on(`GET ${LOGIN}`, { json: state({ status: "signed_in" }) });
    await pollCopilotLogins(ctx());
    const done = (await row(w.workspaceId))!;
    expect(done.status).toBe("signed_in");
    expect(done.detail).toEqual({ signedInAt: clock.now().toISOString() });
    const seeds = agent.callsTo("PUT /v1/workspaces/alice/copilot/provider");
    expect(seeds.map((c) => c.body)).toEqual([{ enabled: true }]);

    // A signed-in row is no longer polled.
    expect(await pollCopilotLogins(ctx())).toBe(0);
  });

  it.each([
    ["expired", {}],
    ["cancelled", {}],
    ["failed", { error: "boom" }],
  ] as const)("terminal %s is recorded", async (status, detail) => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "code");
    agent.on(`GET ${LOGIN}`, {
      json: state({ status, error: "error" in detail ? detail.error : null }),
    });
    await pollCopilotLogins(ctx());
    const r = (await row(w.workspaceId))!;
    expect(r.status).toBe(status);
    expect(r.detail).toEqual(detail);
  });

  it("a sign-in that succeeded but could not seed T3 stays signed in and records why", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "code");
    agent.on(`GET ${LOGIN}`, { json: state({ status: "signed_in" }) });
    agent.on("PUT /v1/workspaces/alice/copilot/provider", {
      status: 409,
      json: { error: "T3 settings.json is not valid JSON; left untouched" },
    });
    await pollCopilotLogins(ctx());
    const r = (await row(w.workspaceId))!;
    expect(r.status).toBe("signed_in");
    expect(r.detail).toMatchObject({ providerError: expect.stringContaining("not valid JSON") });

    // The next account sync retries and clears the error.
    agent.on("PUT /v1/workspaces/alice/copilot/provider", { json: { ok: true } });
    await reconcileCopilot(ctx(), await ws(w.workspaceId));
    expect((await row(w.workspaceId))!.detail).toEqual({ signedInAt: clock.now().toISOString() });
  });

  it("cancelling kills the session and ends cancelled; late polls cannot revive it", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "cancelling", { userCode: "9B0A-2584" });
    agent.on(`GET ${LOGIN}`, { json: CODE });
    await pollCopilotLogins(ctx());
    expect(agent.callsTo(`DELETE ${LOGIN}`)).toHaveLength(1);
    expect((await row(w.workspaceId))!.status).toBe("cancelled");
  });

  it("an idle agent reply fails a sign-in only after the start grace period", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "starting");
    agent.on(`GET ${LOGIN}`, { json: state() });
    await pollCopilotLogins(ctx());
    expect((await row(w.workspaceId))!.status).toBe("starting");
    clock.advance(61_000);
    await pollCopilotLogins(ctx());
    expect((await row(w.workspaceId))!.status).toBe("failed");
  });

  it("a stopped workspace fails a live sign-in; a 409 from the agent does too", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "code");
    await t.db.update(workspaces).set({ status: "sleeping" });
    await pollCopilotLogins(ctx());
    expect((await row(w.workspaceId))!.status).toBe("failed");

    await t.db.update(workspaces).set({ status: "running" });
    await t.db.delete(workspaceIntegrations);
    await seedRow(w.workspaceId, "code");
    agent.on(`GET ${LOGIN}`, { status: 409, json: { error: "workspace alice is not running" } });
    await pollCopilotLogins(ctx());
    expect((await row(w.workspaceId))!.status).toBe("failed");
  });

  it("start on a sleeping workspace or with the CLI missing records a readable failure", async () => {
    const sleeping = await seedWorld(t.db, { status: "sleeping" });
    await seedRow(sleeping.workspaceId, "starting");
    await startCopilotLogin(ctx(), await ws(sleeping.workspaceId));
    expect((await row(sleeping.workspaceId))!.detail).toMatchObject({
      error: expect.stringContaining("not running"),
    });
    expect(agent.calls).toHaveLength(0);

    await t.db.update(workspaces).set({ status: "running" });
    await t.db.delete(workspaceIntegrations);
    await seedRow(sleeping.workspaceId, "starting");
    agent.on(`POST ${LOGIN}`, {
      status: 409,
      json: { error: "the copilot CLI is not installed in this workspace" },
    });
    await startCopilotLogin(ctx(), await ws(sleeping.workspaceId));
    const r = (await row(sleeping.workspaceId))!;
    expect(r.status).toBe("failed");
    expect(r.detail).toEqual({ error: "the copilot CLI is not installed in this workspace" });
  });
});

describe("disconnect reverse state (worker)", () => {
  it("signing_out: logs Copilot out in the workspace, then deletes the row", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "signing_out");
    await reconcileCopilot(ctx(), await ws(w.workspaceId));
    expect(agent.callsTo("DELETE /v1/workspaces/alice/copilot")).toHaveLength(1);
    expect(await row(w.workspaceId)).toBeUndefined();
  });

  it("a Copilot login the user made in a terminal (no row) is never touched", async () => {
    const w = await seedWorld(t.db);
    await reconcileCopilot(ctx(), await ws(w.workspaceId));
    expect(agent.calls).toHaveLength(0);
  });

  it("sync with no GitHub link runs gh disconnect and then the Copilot sign-out; sleeping defers both", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    await seedRow(w.workspaceId, "signing_out");
    await reconcileGithub(ctx(), await ws(w.workspaceId));
    expect(agent.calls).toHaveLength(0);
    expect((await ws(w.workspaceId)).githubSyncPending).toBe(true);
    expect((await row(w.workspaceId))!.status).toBe("signing_out");

    await t.db.update(workspaces).set({ status: "running" });
    await reconcileGithub(ctx(), await ws(w.workspaceId));
    expect(agent.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/workspaces/alice/github",
      "DELETE /v1/workspaces/alice/copilot",
    ]);
    expect(await row(w.workspaceId)).toBeUndefined();
    expect((await ws(w.workspaceId)).githubSyncPending).toBe(false);
  });

  it("a signed-in workspace gets the T3 provider (idempotent upsert) on every sync", async () => {
    const w = await seedWorld(t.db);
    await seedRow(w.workspaceId, "signed_in", { signedInAt: "2026-03-01T00:00:00.000Z" });
    await reconcileGithub(ctx(), await ws(w.workspaceId));
    await reconcileGithub(ctx(), await ws(w.workspaceId));
    const seeds = agent.callsTo("PUT /v1/workspaces/alice/copilot/provider");
    expect(seeds.map((c) => c.body)).toEqual([{ enabled: true }, { enabled: true }]);
    expect((await row(w.workspaceId))!.status).toBe("signed_in");
  });
});
