import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, jobs, toolchainRuns, workspaceTools, workspaces } from "@agentbox/db/schema";
import { UserError } from "../lib/errors";
import { assertCanApplyToolchain } from "../lib/toolchain/gate";
import {
  installTool,
  reinstallTool,
  removeTool,
  retryFailed,
  rollbackTool,
  selectToolVersion,
  upgradeAll,
  upgradeTool,
  validateSelection,
} from "../lib/toolchain/ops";
import { loadToolsView } from "../lib/toolchain/view";
import { requireEntry } from "@agentbox/core/toolchain";
import { createTestDb, type TestDb } from "./helpers/db";
import { markInstalled, PYTHON_VERSIONS, seedLatest, seedTenant } from "./helpers/toolchain";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await seedLatest(t.db);
});
afterAll(() => t.close());

const actorOf = (userId: string) => ({ userId, ip: "198.51.100.7" });
const reconcileJobs = (workspaceId: string) =>
  t.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "reconcile_toolchain")));
const audits = (workspaceId: string, action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetId, workspaceId), eq(auditLog.action, action)));
const rowOf = async (workspaceId: string, toolId: string) =>
  (
    await t.db
      .select()
      .from(workspaceTools)
      .where(and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.toolId, toolId)))
  )[0]!;

async function rejects(p: Promise<unknown>, match: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UserError);
  expect((err as UserError).message).toMatch(match);
}

describe("loadToolsView", () => {
  it("returns null without a workspace", async () => {
    expect(await loadToolsView(t.db, "nobody")).toBeNull();
  });

  it("seeds the default tools lazily and resolves channels against the published versions", async () => {
    const { userId, ws } = await seedTenant(t.db);
    const view = await loadToolsView(t.db, userId);
    expect(view).not.toBeNull();
    const node = view!.tools.find((x) => x.toolId === "node")!;
    expect(node.channel).toBe("lts");
    expect(node.target).toBe("24.22.2");
    // The image ships node: no managed copy yet.
    expect(node.state).toBe("external");
    expect(node.canInstall).toBe(true);
    expect(view!.tools.find((x) => x.toolId === "bun")!.target).toBe("1.3.2");
    expect(view!.tools.find((x) => x.toolId === "bun")!.state).toBe("pending");
    // Seeding again changes nothing.
    await loadToolsView(t.db, userId);
    const rows = await t.db
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
    expect(rows.length).toBe(6);
  });

  it("resolves a python line to the newest patch and reports update availability", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await loadToolsView(t.db, userId);
    await markInstalled(t.db, ws.id, "python", {
      channel: "pin",
      pinnedVersion: "3.12",
      installedVersion: "3.12.9",
    });
    await markInstalled(t.db, ws.id, "node", { channel: "lts", installedVersion: "24.20.0" });
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.2" });
    const view = (await loadToolsView(t.db, userId))!;
    const py = view.tools.find((x) => x.toolId === "python")!;
    expect(py.target).toBe("3.12.16");
    expect(py.updateAvailable).toBe("3.12.16");
    expect(py.lines.map((l) => l.line)).toContain("3.12");
    expect(py.pins).toEqual([]);
    const node = view.tools.find((x) => x.toolId === "node")!;
    expect(node.updateAvailable).toBe("24.22.2");
    expect(view.tools.find((x) => x.toolId === "bun")!.updateAvailable).toBeNull();
    expect(view.tools.find((x) => x.toolId === "bun")!.canUpgrade).toBe(false);
  });

  it("reports the open run with its progress and log tail", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await t.db.insert(toolchainRuns).values({
      workspaceId: ws.id,
      trigger: "user",
      status: "running",
      generation: 1,
      plan: {
        steps: [{ tool: "bun", action: "install", from: null, to: "1.3.2" }],
        skipped: [],
        errors: [],
      },
      steps: [{ tool: "bun", action: "install", status: "running" }],
      log: "a\nb",
    });
    const view = (await loadToolsView(t.db, userId))!;
    expect(view.run?.open).toBe(true);
    expect(view.run?.progress).toEqual({ done: 0, total: 1 });
    expect(view.run?.logTail).toBe("a\nb");
  });
});

describe("validateSelection", () => {
  const info = {
    latest: "3.14.2",
    lts: null,
    versions: PYTHON_VERSIONS,
  };
  it("accepts a python line and rejects an arbitrary patch", () => {
    const py = requireEntry("python");
    expect(validateSelection(py, { channel: "pin", pinnedVersion: "3.12" }, info)).toEqual({
      channel: "pin",
      pinnedVersion: "3.12",
    });
    expect(() => validateSelection(py, { channel: "pin", pinnedVersion: "3.12.1" }, info)).toThrow(
      UserError,
    );
    expect(() => validateSelection(py, { channel: "pin", pinnedVersion: "3" }, info)).toThrow(
      UserError,
    );
    expect(() => validateSelection(py, { channel: "pin", pinnedVersion: "2.7" }, info)).toThrow(
      UserError,
    );
    expect(() => validateSelection(py, { channel: "lts" }, info)).toThrow(/does not support/);
  });
  it("accepts exact versions only from the published list for other tools", () => {
    const claude = requireEntry("claude");
    const claudeInfo = { latest: "2.1.314", lts: null, versions: ["2.1.314", "2.1.300"] };
    expect(
      validateSelection(claude, { channel: "pin", pinnedVersion: "2.1.300" }, claudeInfo)
        .pinnedVersion,
    ).toBe("2.1.300");
    expect(() =>
      validateSelection(claude, { channel: "pin", pinnedVersion: "2.1.299" }, claudeInfo),
    ).toThrow(UserError);
    expect(() =>
      validateSelection(claude, { channel: "pin", pinnedVersion: "2.1" }, claudeInfo),
    ).toThrow(UserError);
    expect(() =>
      validateSelection(claude, { channel: "pin", pinnedVersion: "2.1.300; rm" }, claudeInfo),
    ).toThrow(UserError);
    expect(() =>
      validateSelection(claude, { channel: "pin", pinnedVersion: "2.1.300" }, undefined),
    ).toThrow(/Check for updates/);
  });
});

describe("tool actions", () => {
  it("pins python to a line, rejects a stale patch, and audits", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await rejects(
      selectToolVersion(t.db, actorOf(userId), {
        toolId: "python",
        selection: { channel: "pin", pinnedVersion: "3.12.1" },
      }),
      /version line/,
    );
    expect(await reconcileJobs(ws.id)).toHaveLength(0);
    const res = await selectToolVersion(t.db, actorOf(userId), {
      toolId: "python",
      selection: { channel: "pin", pinnedVersion: "3.12" },
    });
    expect(res.newRun).toBe(true);
    const row = await rowOf(ws.id, "python");
    expect(row).toMatchObject({
      channel: "pin",
      pinnedVersion: "3.12",
      desired: true,
      source: "user",
    });
    expect(await reconcileJobs(ws.id)).toHaveLength(1);
    const [a] = await audits(ws.id, "toolchain.pin");
    expect(a?.actorId).toBe(userId);
    expect(a?.metadata).toMatchObject({
      tool: "python",
      to: { channel: "pin", pinnedVersion: "3.12" },
    });
  });

  it("installs a tool that has no row yet and rejects a second install", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await installTool(t.db, actorOf(userId), { toolId: "grok" });
    expect(await rowOf(ws.id, "grok")).toMatchObject({ desired: true, channel: "latest" });
    expect(await audits(ws.id, "toolchain.install")).toHaveLength(1);
    await markInstalled(t.db, ws.id, "grok", { installedVersion: "1.0.0" });
    await rejects(installTool(t.db, actorOf(userId), { toolId: "grok" }), /already installed/);
  });

  it("installs a package manager only when its language is wanted", async () => {
    const { userId, ws } = await seedTenant(t.db);
    const view = await loadToolsView(t.db, userId);
    const maven = view!.tools.find((x) => x.toolId === "maven")!;
    expect(maven).toMatchObject({ kind: "package-manager", requires: "java", canInstall: false });
    expect(maven.installBlockedReason).toBe("Install Java first");
    await rejects(installTool(t.db, actorOf(userId), { toolId: "maven" }), /Maven needs Java/);
    await rejects(
      selectToolVersion(t.db, actorOf(userId), {
        toolId: "maven",
        selection: { channel: "latest" },
      }),
      /Maven needs Java/,
    );
    expect(
      await t.db
        .select()
        .from(workspaceTools)
        .where(and(eq(workspaceTools.workspaceId, ws.id), eq(workspaceTools.toolId, "maven"))),
    ).toHaveLength(0);

    // Node is a default (wanted) language, so its package managers install.
    const pnpm = (await loadToolsView(t.db, userId))!.tools.find((x) => x.toolId === "pnpm")!;
    expect(pnpm).toMatchObject({ canInstall: true, installBlockedReason: null });
    await installTool(t.db, actorOf(userId), { toolId: "pnpm" });
    expect(await rowOf(ws.id, "pnpm")).toMatchObject({ desired: true, channel: "latest" });
  });

  it("rolls back only when a previous version is kept", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.2" });
    await rejects(rollbackTool(t.db, actorOf(userId), { toolId: "bun" }), /no previous version/);
    await markInstalled(t.db, ws.id, "bun", {
      installedVersion: "1.3.2",
      previousVersion: "1.3.1",
    });
    await rollbackTool(t.db, actorOf(userId), { toolId: "bun" });
    expect((await rowOf(ws.id, "bun")).requestedAction).toBe("rollback");
    expect(await audits(ws.id, "toolchain.rollback")).toHaveLength(1);
  });

  it("removes a managed tool and refuses image-provided or missing ones", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await loadToolsView(t.db, userId); // node is external (shipped by the image)
    await rejects(removeTool(t.db, actorOf(userId), { toolId: "node" }), /image/);
    await rejects(removeTool(t.db, actorOf(userId), { toolId: "grok" }), /not installed/);
    await markInstalled(t.db, ws.id, "bun", { installedVersion: "1.3.2" });
    await removeTool(t.db, actorOf(userId), { toolId: "bun" });
    expect((await rowOf(ws.id, "bun")).desired).toBe(false);
    expect(await audits(ws.id, "toolchain.remove")).toHaveLength(1);
  });

  it("upgrades one tool only when a newer version exists, and all due tools together", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.2" });
    await rejects(upgradeTool(t.db, actorOf(userId), { toolId: "bun" }), /up to date/);
    await rejects(upgradeAll(t.db, actorOf(userId)), /up to date/);
    await markInstalled(t.db, ws.id, "bun", { installedVersion: "1.3.1" });
    await markInstalled(t.db, ws.id, "claude", { channel: "latest", installedVersion: "2.1.300" });
    await upgradeAll(t.db, actorOf(userId));
    expect((await rowOf(ws.id, "bun")).requestedAction).toBe("upgrade");
    expect((await rowOf(ws.id, "claude")).requestedAction).toBe("upgrade");
    const [a] = await audits(ws.id, "toolchain.upgrade");
    expect(a?.metadata).toMatchObject({ all: true });
  });

  it("reinstalls a managed tool and retries a failed run", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await rejects(reinstallTool(t.db, actorOf(userId), { toolId: "bun" }), /not installed/);
    await rejects(retryFailed(t.db, actorOf(userId)), /Nothing failed/);
    await markInstalled(t.db, ws.id, "bun", {
      installedVersion: "1.3.1",
      state: "failed",
      lastError: "boom",
    });
    await reinstallTool(t.db, actorOf(userId), { toolId: "bun" });
    expect((await rowOf(ws.id, "bun")).requestedAction).toBe("reinstall");
    await retryFailed(t.db, actorOf(userId));
    // The failed bun can be upgraded, so the retry requests it.
    expect((await rowOf(ws.id, "bun")).requestedAction).toBe("upgrade");
    expect(await audits(ws.id, "toolchain.retry")).toHaveLength(1);
  });
});

describe("registry tools", () => {
  const RG = "mise:ripgrep" as const;

  it("validates typed pins without a published list", () => {
    const entry = requireEntry(RG);
    expect(validateSelection(entry, { channel: "latest" }, undefined)).toEqual({
      channel: "latest",
      pinnedVersion: null,
    });
    expect(
      validateSelection(entry, { channel: "pin", pinnedVersion: "14.1.0" }, undefined),
    ).toEqual({
      channel: "pin",
      pinnedVersion: "14.1.0",
    });
    for (const bad of [null, "", "-1", "1;id", "a b"]) {
      expect(() =>
        validateSelection(entry, { channel: "pin", pinnedVersion: bad }, undefined),
      ).toThrow(UserError);
    }
    expect(() => validateSelection(entry, { channel: "lts" }, undefined)).toThrow(/lts channel/);
  });

  it("adds, changes, reinstalls and removes a registry tool; hides it again once removed", async () => {
    const { userId, ws } = await seedTenant(t.db);
    expect((await loadToolsView(t.db, userId))!.tools.some((x) => x.kind === "registry")).toBe(
      false,
    );

    await expect(
      installTool(t.db, actorOf(userId), { toolId: "mise:no-such-tool-xyz" as never }),
    ).rejects.toThrow(/unknown tool/);
    await installTool(t.db, actorOf(userId), {
      toolId: RG,
      selection: { channel: "pin", pinnedVersion: "14.1" },
    });
    expect(await rowOf(ws.id, RG)).toMatchObject({
      desired: true,
      channel: "pin",
      pinnedVersion: "14.1",
      source: "user",
    });
    expect(await reconcileJobs(ws.id)).toHaveLength(1);

    await markInstalled(t.db, ws.id, RG, {
      installedVersion: "14.1.1",
      backend: "aqua:BurntSushi/ripgrep",
    });
    const row = (await loadToolsView(t.db, userId))!.tools.find((x) => x.toolId === RG)!;
    expect(row).toMatchObject({
      kind: "registry",
      managed: true,
      sizeHintMb: null,
      updateAvailable: null,
      canUpgrade: false,
      canRollback: false,
      canReinstall: true,
      canRemove: true,
    });
    await rejects(installTool(t.db, actorOf(userId), { toolId: RG }), /already installed/);

    await selectToolVersion(t.db, actorOf(userId), {
      toolId: RG,
      selection: { channel: "latest" },
    });
    expect(await rowOf(ws.id, RG)).toMatchObject({ channel: "latest", pinnedVersion: null });
    await rejects(
      selectToolVersion(t.db, actorOf(userId), {
        toolId: RG,
        selection: { channel: "pin", pinnedVersion: "1;id" },
      }),
      /valid version/,
    );
    await reinstallTool(t.db, actorOf(userId), { toolId: RG });
    expect((await rowOf(ws.id, RG)).requestedAction).toBe("reinstall");
    await rejects(upgradeTool(t.db, actorOf(userId), { toolId: RG }), /up to date/);

    await removeTool(t.db, actorOf(userId), { toolId: RG });
    expect((await rowOf(ws.id, RG)).desired).toBe(false);
  });
});

describe("reconcile enqueue", () => {
  it("coalesces repeated requests into one run and one job", async () => {
    const { userId, ws } = await seedTenant(t.db);
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.1" });
    const first = await upgradeTool(t.db, actorOf(userId), { toolId: "bun" });
    await markInstalled(t.db, ws.id, "claude", { channel: "latest", installedVersion: "2.1.300" });
    const second = await upgradeTool(t.db, actorOf(userId), { toolId: "claude" });
    expect(first.newRun).toBe(true);
    expect(second.newRun).toBe(false);
    expect(second.runId).toBe(first.runId);
    expect(await reconcileJobs(ws.id)).toHaveLength(1);
    const runs = await t.db
      .select()
      .from(toolchainRuns)
      .where(eq(toolchainRuns.workspaceId, ws.id));
    expect(runs).toHaveLength(1);
    const [row] = await t.db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row!.toolchainGeneration).toBe(2);
  });

  it("enqueues for a sleeping workspace without a manual start", async () => {
    const { userId, ws } = await seedTenant(t.db, { status: "sleeping" });
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.1" });
    const res = await upgradeTool(t.db, actorOf(userId), { toolId: "bun" });
    expect(res.newRun).toBe(true);
    expect(await reconcileJobs(ws.id)).toHaveLength(1);
    const starts = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, ws.id), eq(jobs.type, "start_workspace")));
    expect(starts).toHaveLength(0);
  });
});

describe("billing gate", () => {
  it("refuses a sleeping workspace whose plan cannot wake, with the reason", async () => {
    const { userId, ws } = await seedTenant(t.db, { status: "sleeping", billing: "empty" });
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.1" });
    await rejects(
      upgradeTool(t.db, actorOf(userId), { toolId: "bun" }),
      /No included runtime or credits left/,
    );
    expect(await reconcileJobs(ws.id)).toHaveLength(0);
    expect(await audits(ws.id, "toolchain.upgrade")).toHaveLength(0);
  });

  it("does not block a workspace that is already running", async () => {
    const { userId, ws } = await seedTenant(t.db, { status: "running", billing: "empty" });
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.1" });
    await upgradeTool(t.db, actorOf(userId), { toolId: "bun" });
    expect(await reconcileJobs(ws.id)).toHaveLength(1);
  });

  it("refuses a suspended account", async () => {
    const { userId } = await seedTenant(t.db, { status: "running", access: "suspended" });
    await rejects(
      assertCanApplyToolchain(t.db, { userId, workspaceStatus: "running" }),
      /suspended/,
    );
  });
});
