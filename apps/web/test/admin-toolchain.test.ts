import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NODE_INDEX_URL, type FetchLike } from "@agentbox/core/toolchain";
import { auditLog, jobs, toolLatest, workspaces } from "@agentbox/db/schema";
import {
  loadAdminToolchain,
  reconcileAll,
  reconcileWorkspace,
  validateToolchainSettings,
} from "../lib/admin/toolchain-ops";
import { UserError } from "../lib/errors";
import { refreshToolLatest } from "../lib/toolchain/latest";
import { createTestDb, seedAdmin, type TestDb } from "./helpers/db";
import { markInstalled, PYTHON_VERSIONS, seedLatest, seedTenant } from "./helpers/toolchain";

let t: TestDb;
let adminId: string;
beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
  await seedLatest(t.db);
});
afterAll(() => t.close());

const actor = () => ({ adminId, ip: "198.51.100.9" });
const reconcileJobs = (workspaceId: string) =>
  t.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "reconcile_toolchain")));

describe("validateToolchainSettings", () => {
  const latest = new Map([
    ["python", { latest: "3.14.2", lts: null, versions: PYTHON_VERSIONS }],
    ["claude", { latest: "2.1.314", lts: null, versions: ["2.1.314", "2.1.300"] }],
  ]);
  const check = (defaults: unknown[]) =>
    validateToolchainSettings({ defaults: defaults as never, disabled: [] }, latest);

  it("accepts channels and pins the catalog allows", () => {
    expect(() =>
      check([
        { tool: "node", channel: "lts" },
        { tool: "python", channel: "pin", pinnedVersion: "3.12" },
        { tool: "claude", channel: "pin", pinnedVersion: "2.1.300" },
      ]),
    ).not.toThrow();
  });

  it("rejects stale patches, unsupported channels, duplicates and bad versions", () => {
    expect(() => check([{ tool: "python", channel: "pin", pinnedVersion: "3.12.1" }])).toThrow(
      UserError,
    );
    expect(() => check([{ tool: "python", channel: "lts" }])).toThrow(UserError);
    expect(() => check([{ tool: "node", channel: "pin" }])).toThrow(UserError);
    expect(() =>
      check([
        { tool: "node", channel: "lts" },
        { tool: "node", channel: "latest" },
      ]),
    ).toThrow(/twice/);
    expect(() => check([{ tool: "claude", channel: "pin", pinnedVersion: "x y" }])).toThrow(
      UserError,
    );
    expect(() => check([{ tool: "nope", channel: "latest" }])).toThrow(UserError);
  });
});

describe("refreshToolLatest", () => {
  it("stores what sources publish, keeps old data on failure, and throttles user checks", async () => {
    const nodeIndex = [
      { version: "v26.13.0", lts: false },
      { version: "v24.22.2", lts: "Krypton" },
    ];
    const fetchImpl: FetchLike = async (url) => {
      if (url === NODE_INDEX_URL) {
        return { ok: true, status: 200, json: async () => nodeIndex, text: async () => "" };
      }
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    };
    const res = await refreshToolLatest(t.db, {
      actorId: adminId,
      ip: null,
      force: true,
      fetchImpl,
    });
    expect(res.refreshed).toEqual(["node"]);
    expect(res.failed.map((f) => f.toolId)).toContain("python");
    const [node] = await t.db.select().from(toolLatest).where(eq(toolLatest.toolId, "node"));
    expect(node).toMatchObject({ latest: "26.13.0", lts: "24.22.2", error: null });
    // Python failed: the previously stored versions survive and the error is recorded.
    const [py] = await t.db.select().from(toolLatest).where(eq(toolLatest.toolId, "python"));
    expect(py!.versions).toEqual(PYTHON_VERSIONS);
    expect(py!.error).toMatch(/503/);

    const again = await refreshToolLatest(t.db, {
      actorId: adminId,
      ip: null,
      force: false,
      fetchImpl,
    });
    expect(again.skipped).toContain("node");
    expect(again.refreshed).not.toContain("node");
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "toolchain.refresh"));
    expect(audit.length).toBe(2);
  });
});

describe("reconcile", () => {
  it("reconciles one workspace as admin and refuses one that is deleting", async () => {
    const { ws } = await seedTenant(t.db, { status: "sleeping" });
    const res = await reconcileWorkspace(t.db, actor(), ws.slug);
    expect(res.newRun).toBe(true);
    expect(await reconcileJobs(ws.id)).toHaveLength(1);
    const again = await reconcileWorkspace(t.db, actor(), ws.slug);
    expect(again.newRun).toBe(false);
    expect(again.runId).toBe(res.runId);
    expect(await reconcileJobs(ws.id)).toHaveLength(1);

    const gone = await seedTenant(t.db, { status: "deleting" });
    await expect(reconcileWorkspace(t.db, actor(), gone.ws.slug)).rejects.toBeInstanceOf(UserError);
  });

  it("reconcile all: default includes sleeping, running-only skips them, blocked owners are skipped", async () => {
    await t.db.delete(jobs);
    await t.db.delete(workspaces);
    const running = await seedTenant(t.db, { status: "running" });
    const sleeping = await seedTenant(t.db, { status: "sleeping" });
    const broke = await seedTenant(t.db, { status: "sleeping", billing: "empty" });
    const provisioning = await seedTenant(t.db, { status: "provisioning" });

    const view = await loadAdminToolchain(t.db);
    expect(view.liveCount).toBe(3);
    expect(view.runningCount).toBe(1);

    const onlyRunning = await reconcileAll(t.db, actor(), { runningOnly: true });
    expect(onlyRunning).toEqual({
      requested: 1,
      coalesced: 0,
      skippedNotRunning: 2,
      skippedBlocked: 0,
    });
    expect(await reconcileJobs(running.ws.id)).toHaveLength(1);
    expect(await reconcileJobs(sleeping.ws.id)).toHaveLength(0);

    const all = await reconcileAll(t.db, actor(), { runningOnly: false });
    // The running workspace already has an open run; the sleeping one gets a new one; the owner
    // without credits is skipped.
    expect(all).toEqual({ requested: 2, coalesced: 1, skippedNotRunning: 0, skippedBlocked: 1 });
    expect(await reconcileJobs(sleeping.ws.id)).toHaveLength(1);
    expect(await reconcileJobs(broke.ws.id)).toHaveLength(0);
    expect(await reconcileJobs(provisioning.ws.id)).toHaveLength(0);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "toolchain.reconcile_all"));
    expect(audit).toHaveLength(2);
  });
});

describe("loadAdminToolchain", () => {
  it("summarises the fleet with outdated and failed counts", async () => {
    await t.db.delete(jobs);
    await t.db.delete(workspaces);
    const { ws } = await seedTenant(t.db, { status: "running" });
    await markInstalled(t.db, ws.id, "bun", { channel: "latest", installedVersion: "1.3.1" });
    await markInstalled(t.db, ws.id, "claude", { installedVersion: "2.1.300", state: "failed" });
    const view = await loadAdminToolchain(t.db);
    const row = view.fleet.find((f) => f.slug === ws.slug)!;
    expect(row.cells.bun).toMatchObject({ installed: "1.3.1", outdated: true });
    expect(row.outdated).toBeGreaterThanOrEqual(1);
    expect(row.failed).toBe(1);
    expect(view.latest.find((l) => l.toolId === "python")?.versionCount).toBeGreaterThan(0);
    expect(view.catalog.find((c) => c.toolId === "node")?.defaultChannel).toBe("lts");
    expect(view.catalog.find((c) => c.toolId === "grok")?.defaultChannel).toBeNull();
  });
});
