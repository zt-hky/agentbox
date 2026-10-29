import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  hostStats,
  jobs,
  plans,
  subscriptions,
  usageSamples,
  workspaces,
} from "@agentbox/db/schema";
import {
  enqueueDiagnostic,
  enqueueRestart,
  latestDiagnostics,
  loadRack,
  loadUsageSeries,
  readDiagnosticJob,
  resetStartFailures,
} from "../lib/admin/workspaces-ops";
import { UserError } from "../lib/errors";
import { createTestDb, seedAdmin, seedUser, type TestDb } from "./helpers/db";

let t: TestDb;
let adminId: string;
let n = 0;
const actor = () => ({ adminId, ip: "198.51.100.9" });
const now = new Date("2026-03-01T12:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
});
afterAll(() => t.close());

async function seedWorkspace(
  status: (typeof workspaces.$inferInsert)["status"],
  extra: Partial<typeof workspaces.$inferInsert> = {},
) {
  n++;
  const userId = await seedUser(t.db, `w${n}@example.com`, "active");
  const [ws] = await t.db
    .insert(workspaces)
    .values({ userId, slug: `ws${n}x`, slot: 100 + n, status, identitySecretEnc: "x", ...extra })
    .returning();
  return { ws: ws!, userId };
}

const auditCount = async (action: string, targetId: string) =>
  (
    await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
  ).length;

describe("enqueueDiagnostic", () => {
  it("refuses a workspace that is not running and queues nothing", async () => {
    const { ws } = await seedWorkspace("sleeping");
    await expect(
      enqueueDiagnostic(t.db, actor(), ws, { type: "inspect_workspace" }),
    ).rejects.toBeInstanceOf(UserError);
    expect(await t.db.select().from(jobs).where(eq(jobs.workspaceId, ws.id))).toHaveLength(0);
    expect(await auditCount("workspace.inspect_workspace", ws.id)).toBe(0);
  });

  it("queues the job with its payload and audits once", async () => {
    const { ws } = await seedWorkspace("running");
    const res = await enqueueDiagnostic(t.db, actor(), ws, { type: "fetch_logs", tail: 500 });
    expect(res.deduped).toBe(false);
    const [job] = await t.db.select().from(jobs).where(eq(jobs.id, res.jobId));
    expect(job).toMatchObject({
      type: "fetch_logs",
      status: "queued",
      payload: { tail: 500 },
      workspaceId: ws.id,
    });
    expect(await auditCount("workspace.fetch_logs", ws.id)).toBe(1);
  });

  it("joins the job already in flight instead of queueing a second one", async () => {
    const { ws } = await seedWorkspace("running");
    const first = await enqueueDiagnostic(t.db, actor(), ws, { type: "inspect_workspace" });
    const second = await enqueueDiagnostic(t.db, actor(), ws, { type: "inspect_workspace" });
    expect(second).toEqual({ jobId: first.jobId, deduped: true });
    expect(await t.db.select().from(jobs).where(eq(jobs.workspaceId, ws.id))).toHaveLength(1);
    expect(await auditCount("workspace.inspect_workspace", ws.id)).toBe(1);
  });

  it("allows a new job once the previous one has finished", async () => {
    const { ws } = await seedWorkspace("running");
    const first = await enqueueDiagnostic(t.db, actor(), ws, { type: "inspect_workspace" });
    await t.db
      .update(jobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(jobs.id, first.jobId));
    const second = await enqueueDiagnostic(t.db, actor(), ws, { type: "inspect_workspace" });
    expect(second.deduped).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it("rejects a log tail outside the worker's range", async () => {
    const { ws } = await seedWorkspace("running");
    await expect(
      enqueueDiagnostic(t.db, actor(), ws, { type: "fetch_logs", tail: 5000 }),
    ).rejects.toThrow();
    expect(await t.db.select().from(jobs).where(eq(jobs.workspaceId, ws.id))).toHaveLength(0);
  });
});

describe("readDiagnosticJob and latestDiagnostics", () => {
  it("only returns diagnostic jobs that belong to the workspace", async () => {
    const a = (await seedWorkspace("running")).ws;
    const b = (await seedWorkspace("running")).ws;
    const { jobId } = await enqueueDiagnostic(t.db, actor(), a, { type: "inspect_workspace" });
    expect(await readDiagnosticJob(t.db, a, jobId)).toMatchObject({ id: jobId, status: "queued" });
    expect(await readDiagnosticJob(t.db, b, jobId)).toBeNull();
    const [other] = await t.db
      .insert(jobs)
      .values({ type: "start_workspace", workspaceId: a.id })
      .returning();
    expect(await readDiagnosticJob(t.db, a, other!.id)).toBeNull();
  });

  it("separates the newest job from the newest successful one", async () => {
    const { ws } = await seedWorkspace("running");
    const result = { log: "hello", fetchedAt: now.toISOString() };
    await t.db.insert(jobs).values([
      {
        type: "fetch_logs",
        workspaceId: ws.id,
        status: "done",
        result,
        createdAt: new Date("2026-03-01T10:00:00Z"),
        finishedAt: now,
      },
      {
        type: "fetch_logs",
        workspaceId: ws.id,
        status: "failed",
        lastError: "not running",
        createdAt: new Date("2026-03-01T11:00:00Z"),
      },
    ]);
    const { latest, lastDone } = await latestDiagnostics(t.db, ws.id, "fetch_logs");
    expect(latest).toMatchObject({ status: "failed", lastError: "not running" });
    expect(lastDone).toMatchObject({ status: "done", result });
  });
});

describe("enqueueRestart", () => {
  it("requires a running workspace, dedupes, and audits only the queued request", async () => {
    const sleeping = (await seedWorkspace("sleeping")).ws;
    await expect(enqueueRestart(t.db, actor(), sleeping)).rejects.toBeInstanceOf(UserError);

    const { ws } = await seedWorkspace("running");
    expect(await enqueueRestart(t.db, actor(), ws)).toEqual({ deduped: false });
    expect(await enqueueRestart(t.db, actor(), ws)).toEqual({ deduped: true });
    const queued = await t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, ws.id), eq(jobs.type, "restart_workspace")));
    expect(queued).toHaveLength(1);
    expect(await auditCount("workspace.restart", ws.id)).toBe(1);
  });
});

describe("resetStartFailures", () => {
  it("zeroes the counter and records the previous value", async () => {
    const { ws } = await seedWorkspace("error", { startFailures: 4 });
    await resetStartFailures(t.db, actor(), ws);
    const [after] = await t.db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(after!.startFailures).toBe(0);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "workspace.reset_start_failures"), eq(auditLog.targetId, ws.id)),
      );
    expect(entry!.metadata).toMatchObject({ previous: 4 });
  });

  it("refuses when there is nothing to reset", async () => {
    const { ws } = await seedWorkspace("sleeping");
    await expect(resetStartFailures(t.db, actor(), ws)).rejects.toBeInstanceOf(UserError);
  });
});

describe("loadRack", () => {
  it("joins plan, host stats and the latest fresh usage sample", async () => {
    const [plan] = await t.db.select().from(plans).limit(1);
    const { ws, userId } = await seedWorkspace("running", {
      awakeSince: new Date("2026-03-01T11:00:00Z"),
    });
    await t.db
      .insert(subscriptions)
      .values({ userId, planId: plan!.id, cycleStart: now, cycleEnd: now });
    await t.db.insert(usageSamples).values([
      {
        workspaceId: ws.id,
        ts: new Date("2026-03-01T11:57:00Z"),
        runtimeSec: 60,
        cpuCoreSec: 6,
        memGbSec: 60,
      },
      {
        workspaceId: ws.id,
        ts: new Date("2026-03-01T11:59:00Z"),
        runtimeSec: 60,
        cpuCoreSec: 30,
        memGbSec: 60,
      },
    ]);
    await t.db.insert(hostStats).values({
      id: 1,
      updatedAt: new Date("2026-03-01T11:59:30Z"),
      payload: {
        workspaces: [
          { ws: ws.slug, running: true, memoryCurrent: 1000, startedAt: "2026-03-01T10:00:00Z" },
        ],
        tenants: [
          {
            ws: ws.slug,
            uid: 200000 + ws.slot,
            diskUsedBytes: 500,
            diskLimitBytes: 9000,
            inodesUsed: 1,
            inodesLimit: 2,
          },
        ],
      },
    });

    const rows = await loadRack(t.db, now, { userId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: ws.slug,
      planName: plan!.name,
      cpuCores: 0.5,
      memBytes: 1000,
      diskBytes: 500,
      awakeSince: "2026-03-01T10:00:00.000Z",
    });
    expect(rows[0]!.limits).toMatchObject({ cpus: Number(plan!.cpuLimit), diskBytes: 9000 });
  });

  it("returns every workspace with empty readings once host stats are stale", async () => {
    const rows = await loadRack(t.db, new Date("2026-03-02T12:00:00Z"));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.memBytes === null && r.diskBytes === null)).toBe(true);
  });
});

describe("loadUsageSeries", () => {
  it("buckets samples by interval across the whole range", async () => {
    const { ws } = await seedWorkspace("running");
    await t.db.insert(usageSamples).values([
      {
        workspaceId: ws.id,
        ts: new Date("2026-03-01T11:01:00Z"),
        runtimeSec: 60,
        cpuCoreSec: 60,
        memGbSec: 120,
        chargeMicro: 1_000_000n,
      },
      {
        workspaceId: ws.id,
        ts: new Date("2026-03-01T11:10:00Z"),
        runtimeSec: 60,
        cpuCoreSec: 0,
        memGbSec: 120,
        chargeMicro: 1_000_000n,
      },
      {
        workspaceId: ws.id,
        ts: new Date("2026-02-20T11:10:00Z"),
        runtimeSec: 60,
        cpuCoreSec: 60,
        memGbSec: 60,
      },
    ]);
    const series = await loadUsageSeries(t.db, ws.id, "24h", now);
    expect(series).toHaveLength(97);
    const bucket = series.find((p) => p.t === "2026-03-01T11:00:00.000Z");
    expect(bucket).toEqual({ t: "2026-03-01T11:00:00.000Z", cpuCores: 0.5, memGb: 2, charge: 2 });
    expect(series.filter((p) => p.cpuCores !== null)).toHaveLength(1);
  });
});
