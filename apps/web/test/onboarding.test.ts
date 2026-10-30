import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { decrypt } from "@agentbox/core/tokens";
import { readSetting } from "@agentbox/db/client";
import { upsertToolLatest } from "@agentbox/db/toolchain";
import {
  agentKeys,
  gitConnections,
  jobs,
  toolchainRuns,
  user,
  workspaceSessions,
  workspaceTools,
  workspaces,
} from "@agentbox/db/schema";
import { removeAgentKey, saveAgentKey } from "../lib/agent-keys";
import { grantAccess } from "../lib/approve";
import { loadDashboardToolSummary } from "../lib/dashboard";
import { UserError } from "../lib/errors";
import {
  finishOnboarding,
  loadOnboardingProgress,
  loadOnboardingState,
  progressToolState,
} from "../lib/onboarding";
import { resolveSelection, saveSelection } from "../lib/onboarding-selection";
import { deleteOwnWorkspace, restartOwnWorkspace } from "../lib/user-lifecycle";
import { createWorkspaceForUser } from "../lib/workspace-create";
import { createTestDb, seedAdmin, seedUser, type TestDb } from "./helpers/db";

const KEY = randomBytes(32).toString("base64");
let t: TestDb;
let adminId: string;
let planId: string;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
  planId = (await readSetting(t.db, "billing"))!.defaultPlanId;
});
afterAll(() => t.close());
beforeEach(() => {
  n++;
});

async function approved(slug = `ob${n}x${randomBytes(2).toString("hex")}`) {
  const userId = await seedUser(t.db, `${slug}@example.com`, "none");
  await grantAccess(t.db, { userId, adminId, slug, planId, ip: null });
  return { userId, slug };
}
const wsOf = async (userId: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.userId, userId)))[0]!;
const jobTypes = async (workspaceId: string) =>
  (await t.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId))).map((j) => j.type);
const create = (userId: string) => createWorkspaceForUser(t.db, { userId, encryptionKey: KEY });

describe("selection", () => {
  it("defaults to the admin defaults, then to what the user saved, per kind", async () => {
    const { userId } = await approved();
    const fresh = await resolveSelection(t.db, userId);
    expect(fresh).toMatchObject({ toolsSaved: false, agentsSaved: false });
    expect(fresh.tools).toEqual(expect.arrayContaining(["node", "python", "bun"]));
    expect(fresh.agents).toEqual(expect.arrayContaining(["claude", "codex", "omp"]));

    await saveSelection(t.db, userId, "runtime", ["rust", "go", "java", "rust"]);
    const after = await resolveSelection(t.db, userId);
    expect(after.tools).toEqual(["rust", "go", "java"]);
    expect(after.agents).toEqual(fresh.agents); // the other half is untouched
    expect(after).toMatchObject({ toolsSaved: true, agentsSaved: false });
  });

  it("rejects ids of the wrong kind or unknown tools", async () => {
    const { userId } = await approved();
    await expect(saveSelection(t.db, userId, "runtime", ["claude"])).rejects.toThrow(UserError);
    await expect(saveSelection(t.db, userId, "agent", ["node"])).rejects.toThrow(UserError);
    await expect(saveSelection(t.db, userId, "agent", ["nope"])).rejects.toThrow(UserError);
  });
});

describe("agent keys", () => {
  it("stores encrypted, masks on read, rejects unrelated variables, and queues a sync", async () => {
    const { userId } = await approved();
    const actor = { userId, encryptionKey: KEY, ip: null };
    await expect(
      saveAgentKey(t.db, actor, { agentId: "codex", envVar: "ANTHROPIC_API_KEY", value: "sk-x" }),
    ).rejects.toThrow(/not used by this agent/);
    await expect(
      saveAgentKey(t.db, actor, { agentId: "codex", envVar: "OPENAI_API_KEY", value: "has space" }),
    ).rejects.toThrow(/single line/);

    const secret = "sk-test-0123456789abcdef";
    const { masked } = await saveAgentKey(t.db, actor, {
      agentId: "codex",
      envVar: "OPENAI_API_KEY",
      value: `  ${secret}\n`,
    });
    expect(masked).not.toContain(secret);
    const [row] = await t.db.select().from(agentKeys).where(eq(agentKeys.userId, userId));
    expect(row!.valueEnc).not.toContain(secret);
    expect(decrypt(row!.valueEnc, KEY)).toBe(secret);

    const state = await loadOnboardingState(t.db, userId, { encryptionKey: KEY });
    const codex = state.agents.find((a) => a.toolId === "codex")!;
    expect(codex.saved).toEqual([expect.objectContaining({ envVar: "OPENAI_API_KEY", masked })]);
    expect(JSON.stringify(state)).not.toContain(secret);

    // With a workspace the change is pushed to it.
    await saveSelection(t.db, userId, "runtime", ["node"]);
    await create(userId);
    const ws = await wsOf(userId);
    await t.db.delete(jobs).where(eq(jobs.workspaceId, ws.id));
    await removeAgentKey(t.db, actor, { agentId: "codex", envVar: "OPENAI_API_KEY" });
    expect(await t.db.select().from(agentKeys).where(eq(agentKeys.userId, userId))).toHaveLength(0);
    expect(await jobTypes(ws.id)).toEqual(["sync_agent_keys"]);
  });
});

describe("createWorkspaceForUser", () => {
  it("creates the workspace at onboarding with the selection, pending toolchain and a provision job", async () => {
    const { userId, slug } = await approved();
    await t.db.insert(gitConnections).values({
      userId,
      provider: "github",
      host: "github.com",
      method: "oauth",
      login: "gh",
      tokenEnc: "x",
    });
    await saveSelection(t.db, userId, "runtime", ["rust", "go"]);
    await saveSelection(t.db, userId, "agent", ["claude"]);

    const res = await create(userId);
    expect(res).toMatchObject({ slug, outcome: "provisioned" });
    const ws = await wsOf(userId);
    expect(ws).toMatchObject({
      slug,
      status: "provisioning",
      toolchainPending: true,
      gitSyncPending: true,
      dataKept: false,
    });
    expect(await jobTypes(ws.id)).toEqual(["provision_tenant"]);
    const tools = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
    expect(tools.map((r) => r.toolId).sort()).toEqual(["claude", "go", "rust"]);
    expect(tools.every((r) => r.desired && r.state === "pending" && r.source === "user")).toBe(
      true,
    );

    // Calling again while it is being created changes nothing.
    expect((await create(userId)).outcome).toBe("inflight");
    expect(await jobTypes(ws.id)).toEqual(["provision_tenant"]);
  });

  it("gives every workspace its own slot", async () => {
    const a = await approved();
    const b = await approved();
    await create(a.userId);
    await create(b.userId);
    expect((await wsOf(b.userId)).slot).not.toBe((await wsOf(a.userId)).slot);
  });

  it("needs an active account, a plan and a reserved slug", async () => {
    const none = await seedUser(t.db, `na${n}@example.com`, "none");
    await expect(create(none)).rejects.toThrow(/not active/);
    const active = await seedUser(t.db, `nb${n}@example.com`, "active");
    await expect(create(active)).rejects.toThrow(/no plan/);
  });

  it("refuses while the previous workspace is still being deleted", async () => {
    const { userId } = await approved();
    await create(userId);
    await t.db.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.userId, userId));
    await expect(create(userId)).rejects.toThrow(/delet/i);
  });

  it("re-creating after a wipe-delete reuses the row with a new slot and fresh tools", async () => {
    const { userId } = await approved();
    await saveSelection(t.db, userId, "runtime", ["node"]);
    await create(userId);
    const first = await wsOf(userId);
    await t.db
      .update(workspaces)
      .set({ status: "deleted", dataKept: false })
      .where(eq(workspaces.id, first.id));
    await t.db.delete(jobs).where(eq(jobs.workspaceId, first.id));
    await saveSelection(t.db, userId, "runtime", ["go"]);
    await saveSelection(t.db, userId, "agent", []);

    const res = await create(userId);
    const again = await wsOf(userId);
    expect(res.outcome).toBe("provisioned");
    expect(again.id).toBe(first.id);
    expect(again.slot).toBeGreaterThan(first.slot);
    expect(again.status).toBe("provisioning");
    expect(again.identitySecretEnc).not.toBe(first.identitySecretEnc);
    const tools = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, again.id));
    expect(tools.map((r) => r.toolId)).toEqual(["go"]);
    expect(await jobTypes(again.id)).toEqual(["provision_tenant"]);
  });

  it("re-creating after a keep-data delete reuses the slug and slot (the kept home)", async () => {
    const { userId, slug } = await approved();
    await create(userId);
    const first = await wsOf(userId);
    await t.db
      .update(workspaces)
      .set({ status: "deleted", dataKept: true })
      .where(eq(workspaces.id, first.id));
    await t.db.delete(jobs).where(eq(jobs.workspaceId, first.id));
    await t.db.update(user).set({ reservedSlug: "somethingelse" }).where(eq(user.id, userId));

    await create(userId);
    const again = await wsOf(userId);
    expect(again).toMatchObject({ id: first.id, slug, slot: first.slot, dataKept: false });
    expect(again.status).toBe("provisioning");
    const state = await loadOnboardingState(t.db, userId, { encryptionKey: KEY });
    expect(state.slug).toEqual({ value: slug, locked: true });
  });

  it("applies the selection to an existing workspace and queues a reconcile", async () => {
    const { userId } = await approved();
    await saveSelection(t.db, userId, "runtime", ["node"]);
    await create(userId);
    const ws = await wsOf(userId);
    await t.db
      .update(workspaces)
      .set({ status: "running", toolchainPending: false })
      .where(eq(workspaces.id, ws.id));
    await t.db.delete(jobs).where(eq(jobs.workspaceId, ws.id));

    await saveSelection(t.db, userId, "runtime", ["go"]);
    const res = await create(userId);
    expect(res.outcome).toBe("applied");
    const tools = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
    const by = new Map(tools.map((r) => [r.toolId, r.desired]));
    expect(by.get("go")).toBe(true);
    expect(by.get("node")).toBe(false);
    expect(await jobTypes(ws.id)).toContain("reconcile_toolchain");
    expect(
      (await t.db.select().from(toolchainRuns).where(eq(toolchainRuns.workspaceId, ws.id))).length,
    ).toBe(1);
  });
});

describe("progress and finishing", () => {
  it("walks provision -> start -> tools -> ready and only then lets the user finish", async () => {
    const { userId } = await approved();
    await saveSelection(t.db, userId, "runtime", ["python"]);
    await saveSelection(t.db, userId, "agent", []);
    expect((await loadOnboardingProgress(t.db, userId)).stage).toBe("provision");
    await create(userId);
    const ws = await wsOf(userId);

    let p = await loadOnboardingProgress(t.db, userId);
    expect(p).toMatchObject({ stage: "provision", canFinish: false });
    expect(p.tools).toEqual([expect.objectContaining({ toolId: "python", state: "pending" })]);

    await t.db.update(workspaces).set({ status: "sleeping" }).where(eq(workspaces.id, ws.id));
    p = await loadOnboardingProgress(t.db, userId);
    expect(p.stage).toBe("start");
    expect(p.stages.map((s) => s.state)).toEqual(["done", "active", "pending"]);

    await t.db.update(workspaces).set({ status: "running" }).where(eq(workspaces.id, ws.id));
    p = await loadOnboardingProgress(t.db, userId);
    expect(p.stage).toBe("tools");
    expect(p.canFinish).toBe(false);
    await expect(finishOnboarding(t.db, userId, null)).rejects.toThrow(/not ready/);

    // The worker's start hook queued the run (generation bumped, pending cleared); it succeeds.
    await t.db
      .update(workspaces)
      .set({ toolchainPending: false, toolchainGeneration: 1, toolchainAppliedGeneration: 1 })
      .where(eq(workspaces.id, ws.id));
    await t.db
      .update(workspaceTools)
      .set({ state: "idle", installedVersion: "3.14.2", backend: "python" })
      .where(eq(workspaceTools.workspaceId, ws.id));
    p = await loadOnboardingProgress(t.db, userId);
    expect(p).toMatchObject({ stage: "ready", canFinish: true });
    expect(p.tools[0]).toMatchObject({ state: "installed", version: "3.14.2" });

    await finishOnboarding(t.db, userId, "198.51.100.1");
    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u!.onboardedAt).toBeInstanceOf(Date);
  });

  it("reports a workspace that failed to start as an error stage", async () => {
    const { userId } = await approved();
    await create(userId);
    await t.db.update(workspaces).set({ status: "error" }).where(eq(workspaces.userId, userId));
    const p = await loadOnboardingProgress(t.db, userId);
    expect(p).toMatchObject({ stage: "error", canFinish: false });
    expect(p.error).toMatch(/could not be started/);
  });

  it("maps tool rows to display states", () => {
    const base = { desired: true, installedVersion: null, backend: null };
    expect(progressToolState({ ...base, state: "idle" })).toBe("pending");
    expect(progressToolState({ ...base, state: "idle", installedVersion: "1", backend: "x" })).toBe(
      "installed",
    );
    expect(progressToolState({ ...base, desired: false, state: "idle" })).toBe("idle");
    expect(progressToolState({ ...base, state: "failed" })).toBe("failed");
    expect(progressToolState({ ...base, state: "installing" })).toBe("installing");
  });
});

describe("dashboard summary", () => {
  it("lists wanted and installed tools with counts, null without a live workspace", async () => {
    const { userId } = await approved();
    expect(await loadDashboardToolSummary(t.db, userId)).toBeNull();
    await saveSelection(t.db, userId, "runtime", ["node", "go"]);
    await saveSelection(t.db, userId, "agent", ["claude"]);
    await create(userId);
    const ws = await wsOf(userId);
    await t.db
      .update(workspaceTools)
      .set({ state: "idle", installedVersion: "24.1.0", backend: "node" })
      .where(and(eq(workspaceTools.workspaceId, ws.id), eq(workspaceTools.toolId, "node")));
    await t.db
      .update(workspaceTools)
      .set({ state: "failed", lastError: "boom" })
      .where(and(eq(workspaceTools.workspaceId, ws.id), eq(workspaceTools.toolId, "claude")));
    const s = (await loadDashboardToolSummary(t.db, userId))!;
    expect(s.tools.map((x) => [x.toolId, x.state])).toEqual([
      ["node", "installed"],
      ["go", "pending"],
      ["claude", "failed"],
    ]);
    expect(s.counts).toMatchObject({ installed: 1, pending: 1, failed: 1 });
  });
});

describe("user lifecycle", () => {
  async function liveWorkspace(status: (typeof workspaces.$inferInsert)["status"] = "running") {
    const a = await approved();
    await create(a.userId);
    const ws = await wsOf(a.userId);
    await t.db.update(workspaces).set({ status }).where(eq(workspaces.id, ws.id));
    await t.db.update(user).set({ onboardedAt: new Date() }).where(eq(user.id, a.userId));
    await t.db.delete(jobs).where(eq(jobs.workspaceId, ws.id));
    return { ...a, ws };
  }
  const actor = (userId: string) => ({ userId, ip: null });

  it("restarts a running workspace and refuses other states", async () => {
    const { userId, ws } = await liveWorkspace("running");
    await restartOwnWorkspace(t.db, actor(userId));
    expect(await jobTypes(ws.id)).toEqual(["restart_workspace"]);
    await t.db.update(workspaces).set({ status: "provisioning" }).where(eq(workspaces.id, ws.id));
    await expect(restartOwnWorkspace(t.db, actor(userId))).rejects.toThrow(UserError);
  });

  it("delete with keepData queues a keep-data delete, keeps selection and keys, resets onboarding", async () => {
    const { userId, slug, ws } = await liveWorkspace();
    await saveSelection(t.db, userId, "runtime", ["go"]);
    await saveAgentKey(
      t.db,
      { userId, encryptionKey: KEY, ip: null },
      { agentId: "codex", envVar: "OPENAI_API_KEY", value: "sk-keepkeepkeep1234" },
    );
    await t.db.insert(workspaceSessions).values({
      tokenHash: `h${n}`,
      userId,
      workspaceId: ws.id,
      host: "x",
      expiresAt: new Date(Date.now() + 1000),
    });
    await expect(
      deleteOwnWorkspace(t.db, actor(userId), { keepData: true, confirmSlug: "wrong" }),
    ).rejects.toThrow(/confirm/);

    await deleteOwnWorkspace(t.db, actor(userId), { keepData: true, confirmSlug: slug });
    const after = await wsOf(userId);
    expect(after.status).toBe("deleting");
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, ws.id), eq(jobs.type, "delete_tenant")));
    expect(job).toMatchObject({ type: "delete_tenant", payload: { keepData: true } });
    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u!.onboardedAt).toBeNull();
    expect(u!.onboardingSelection).not.toBeNull();
    expect(await t.db.select().from(agentKeys).where(eq(agentKeys.userId, userId))).toHaveLength(1);
    const sessions = await t.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.userId, userId));
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it("delete without keepData wipes keys and selection and queues a wipe", async () => {
    const { userId, slug, ws } = await liveWorkspace("sleeping");
    await saveSelection(t.db, userId, "runtime", ["go"]);
    await saveAgentKey(
      t.db,
      { userId, encryptionKey: KEY, ip: null },
      { agentId: "codex", envVar: "OPENAI_API_KEY", value: "sk-wipewipewipe1234" },
    );
    await deleteOwnWorkspace(t.db, actor(userId), { keepData: false, confirmSlug: slug });
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, ws.id), eq(jobs.type, "delete_tenant")));
    expect(job).toMatchObject({ type: "delete_tenant", payload: { keepData: false } });
    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u).toMatchObject({ onboardedAt: null, onboardingSelection: null });
    expect(await t.db.select().from(agentKeys).where(eq(agentKeys.userId, userId))).toHaveLength(0);
    await expect(
      deleteOwnWorkspace(t.db, actor(userId), { keepData: false, confirmSlug: slug }),
    ).rejects.toThrow(/already being deleted/);
  });
});

describe("versions and package managers", () => {
  const published = (versions: string[]) => ({
    info: { latest: versions[0] ?? null, lts: null, versions },
  });
  beforeAll(async () => {
    await upsertToolLatest(t.db, "python", published(["3.13.1", "3.12.9", "3.12.8", "3.11.4"]));
    await upsertToolLatest(t.db, "pnpm", published(["10.18.0", "10.17.1", "9.15.9"]));
  });

  it("offers each language and package manager a version select with the default marked", async () => {
    const { userId } = await approved();
    const state = await loadOnboardingState(t.db, userId, { encryptionKey: KEY });
    const node = state.tools.find((x) => x.toolId === "node")!;
    expect(node.version.defaultValue).toBe("lts");
    expect(node.version.value).toBe("lts");
    expect(node.version.options.find((o) => o.value === "lts")?.label).toBe("LTS (default)");
    expect(node.version.options.map((o) => o.value)).toEqual(
      expect.arrayContaining(["latest", "lts"]),
    );
    expect(node.bundled.map((b) => b.name)).toEqual(["npm"]);
    expect(node.managers.map((m) => m.toolId)).toEqual(["pnpm", "yarn"]);

    const python = state.tools.find((x) => x.toolId === "python")!;
    expect(python.version.options.map((o) => o.value)).toEqual([
      "latest",
      "pin:3.13",
      "pin:3.12",
      "pin:3.11",
    ]);
    expect(python.managers.map((m) => m.toolId)).toEqual(["uv", "poetry"]);
    expect(state.tools.find((x) => x.toolId === "rust")!.managers).toEqual([]);
    expect(state.tools.find((x) => x.toolId === "java")!.version.defaultValue).toBe("lts");
    expect(state.selectedManagerIds).toEqual([]);
  });

  it("saves versions, keeps package managers only with their language, and validates choices", async () => {
    const { userId } = await approved();
    await saveSelection(t.db, userId, "runtime", ["python", "uv", "pnpm", "node"], {
      python: { channel: "pin", pinnedVersion: "3.12" },
      pnpm: { channel: "pin", pinnedVersion: "10.17" },
      node: { channel: "latest", pinnedVersion: null },
    });
    let sel = await resolveSelection(t.db, userId);
    expect(sel.tools).toEqual(["python", "node"]);
    expect(sel.packageManagers).toEqual(["uv", "pnpm"]);
    expect(sel.versions).toEqual({
      python: { channel: "pin", pinnedVersion: "3.12" },
      pnpm: { channel: "pin", pinnedVersion: "10.17" },
      node: { channel: "latest", pinnedVersion: null },
    });
    const state = await loadOnboardingState(t.db, userId, { encryptionKey: KEY });
    expect(state.tools.find((x) => x.toolId === "python")!.version.value).toBe("pin:3.12");
    expect(state.selectedManagerIds).toEqual(["uv", "pnpm"]);

    // Removing a language drops its package managers and their versions.
    await saveSelection(t.db, userId, "runtime", ["python", "uv"], {
      python: { channel: "pin", pinnedVersion: "3.12" },
      pnpm: { channel: "latest", pinnedVersion: null },
    });
    sel = await resolveSelection(t.db, userId);
    expect(sel.tools).toEqual(["python"]);
    expect(sel.packageManagers).toEqual(["uv"]);
    expect(Object.keys(sel.versions)).toEqual(["python"]);
    const [u] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(u!.onboardingSelection).toEqual({
      tools: ["python", "uv"],
      versions: { python: { channel: "pin", pinnedVersion: "3.12" } },
    });
    // A package manager without its language is dropped even when asked for directly.
    await saveSelection(t.db, userId, "runtime", ["python", "maven"]);
    expect((await resolveSelection(t.db, userId)).packageManagers).toEqual([]);

    await expect(
      saveSelection(t.db, userId, "runtime", ["python"], {
        python: { channel: "pin", pinnedVersion: "2.7" },
      }),
    ).rejects.toThrow(UserError);
    await expect(
      saveSelection(t.db, userId, "runtime", ["python"], {
        python: { channel: "lts", pinnedVersion: null },
      }),
    ).rejects.toThrow(/does not support the lts channel/);
  });

  it("creates workspace_tools rows with the chosen channel and version for languages and package managers", async () => {
    const { userId } = await approved();
    await saveSelection(t.db, userId, "runtime", ["node", "pnpm", "python", "uv", "go"], {
      node: { channel: "latest", pinnedVersion: null },
      pnpm: { channel: "pin", pinnedVersion: "10.17" },
      python: { channel: "pin", pinnedVersion: "3.12" },
    });
    await saveSelection(t.db, userId, "agent", ["claude"]);
    await create(userId);
    const ws = await wsOf(userId);
    const rows = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
    const byId = Object.fromEntries(rows.map((r) => [r.toolId, r]));
    expect(Object.keys(byId).sort()).toEqual(["claude", "go", "node", "pnpm", "python", "uv"]);
    expect(byId["node"]).toMatchObject({ channel: "latest", pinnedVersion: null, desired: true });
    expect(byId["pnpm"]).toMatchObject({ channel: "pin", pinnedVersion: "10.17", desired: true });
    expect(byId["python"]).toMatchObject({ channel: "pin", pinnedVersion: "3.12", desired: true });
    // No saved choice: the catalog default channel.
    expect(byId["go"]).toMatchObject({ channel: "latest", pinnedVersion: null });
    expect(byId["uv"]).toMatchObject({ channel: "latest", pinnedVersion: null });
    expect(byId["claude"]).toMatchObject({ channel: "latest", desired: true });
  });
});
