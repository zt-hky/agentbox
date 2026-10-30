import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { fetchLogsPayloadSchema } from "@agentbox/core/job-contracts";
import {
  hostStats,
  images,
  jobs,
  plans,
  subscriptions,
  usageSamples,
  user,
  workspaces,
} from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { DbLike } from "../db-types";
import { UserError } from "../errors";
import { workspaceImageState } from "./image-view";
import { STATS_MAX_AGE_MS } from "../live-stats";
import {
  buildRackRow,
  cpuCoresFromFreshSample,
  USAGE_RANGES,
  fillUsageBuckets,
  indexHostStats,
  planLimits,
  type JobView,
  type RackRow,
  type UsageChartPoint,
  type UsagePointRaw,
  type UsageRange,
} from "./workspaces";

type WorkspaceRow = typeof workspaces.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

export const DIAGNOSTIC_TYPES = ["fetch_logs", "inspect_workspace"] as const;
export type DiagnosticType = (typeof DIAGNOSTIC_TYPES)[number];

export type DiagnosticRequest =
  { type: "inspect_workspace" } | { type: "fetch_logs"; tail: number };

export interface AdminActor {
  adminId: string;
  ip: string | null;
}

export function toJobView(j: JobRow): JobView {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    lastError: j.lastError,
    result: j.result,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

export async function findWorkspaceBySlug(
  database: DbLike,
  slug: string,
): Promise<WorkspaceRow | null> {
  const rows = await database.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/**
 * Queue a diagnostic job for a running workspace. The partial unique index keeps one queued/running
 * job per workspace and type, so a second click joins the job already in flight (`deduped`).
 * Audited only when a new job is actually queued.
 */
export async function enqueueDiagnostic(
  database: DbLike,
  actor: AdminActor,
  ws: WorkspaceRow,
  req: DiagnosticRequest,
): Promise<{ jobId: string; deduped: boolean }> {
  if (ws.status !== "running") {
    throw new UserError("The workspace is not running. Start it first, then try again.");
  }
  const payload = req.type === "fetch_logs" ? fetchLogsPayloadSchema.parse({ tail: req.tail }) : {};
  const inserted = await database
    .insert(jobs)
    .values({ type: req.type, workspaceId: ws.id, payload })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  if (inserted[0]) {
    await writeAudit(database, {
      actorId: actor.adminId,
      action: `workspace.${req.type}`,
      targetType: "workspace",
      targetId: ws.id,
      metadata: { slug: ws.slug, ...payload },
      ip: actor.ip,
    });
    return { jobId: inserted[0].id, deduped: false };
  }
  const active = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, ws.id),
        eq(jobs.type, req.type),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (!active[0]) throw new UserError("The previous job just finished. Try again.");
  return { jobId: active[0].id, deduped: true };
}

/** Stop then start; only meaningful for a workspace that is up. */
export async function enqueueRestart(
  database: DbLike,
  actor: AdminActor,
  ws: WorkspaceRow,
): Promise<{ deduped: boolean }> {
  if (ws.status !== "running") {
    throw new UserError(`Cannot restart a workspace that is ${ws.status}. Start it instead.`);
  }
  const inserted = await database
    .insert(jobs)
    .values({ type: "restart_workspace", workspaceId: ws.id, payload: {} })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  if (!inserted[0]) return { deduped: true };
  await writeAudit(database, {
    actorId: actor.adminId,
    action: "workspace.restart",
    targetType: "workspace",
    targetId: ws.id,
    metadata: { slug: ws.slug },
    ip: actor.ip,
  });
  return { deduped: false };
}

export async function resetStartFailures(
  database: DbLike,
  actor: AdminActor,
  ws: WorkspaceRow,
): Promise<void> {
  if (ws.startFailures === 0) throw new UserError("This workspace has no start failures to reset.");
  await database.update(workspaces).set({ startFailures: 0 }).where(eq(workspaces.id, ws.id));
  await writeAudit(database, {
    actorId: actor.adminId,
    action: "workspace.reset_start_failures",
    targetType: "workspace",
    targetId: ws.id,
    metadata: { slug: ws.slug, previous: ws.startFailures },
    ip: actor.ip,
  });
}

/** One of this workspace's diagnostic jobs, or null when the id belongs to another workspace/type. */
export async function readDiagnosticJob(
  database: DbLike,
  ws: Pick<WorkspaceRow, "id">,
  jobId: string,
): Promise<JobView | null> {
  const rows = await database
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workspaceId, ws.id),
        inArray(jobs.type, [...DIAGNOSTIC_TYPES]),
      ),
    )
    .limit(1);
  return rows[0] ? toJobView(rows[0]) : null;
}

/** Newest job of the type, and the newest successful one (its result is what the panel shows). */
export async function latestDiagnostics(
  database: DbLike,
  workspaceId: string,
  type: DiagnosticType,
): Promise<{ latest: JobView | null; lastDone: JobView | null }> {
  const base = and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, type));
  const [latest, done] = await Promise.all([
    database.select().from(jobs).where(base).orderBy(desc(jobs.createdAt)).limit(1),
    database
      .select()
      .from(jobs)
      .where(and(base, eq(jobs.status, "done")))
      .orderBy(desc(jobs.createdAt))
      .limit(1),
  ]);
  return {
    latest: latest[0] ? toJobView(latest[0]) : null,
    lastDone: done[0] ? toJobView(done[0]) : null,
  };
}

/** Every workspace as a rack row: DB facts joined with the latest fresh host_stats snapshot. */
export async function loadRack(
  database: DbLike,
  now: Date = new Date(),
  filter: { userId?: string } = {},
): Promise<RackRow[]> {
  const [rows, stats, samples, imageRows] = await Promise.all([
    database
      .select({ w: workspaces, email: user.email, plan: plans })
      .from(workspaces)
      .innerJoin(user, eq(user.id, workspaces.userId))
      .leftJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .where(filter.userId ? eq(workspaces.userId, filter.userId) : undefined)
      .orderBy(workspaces.slug),
    database.select().from(hostStats).where(eq(hostStats.id, 1)).limit(1),
    database
      .selectDistinctOn([usageSamples.workspaceId], {
        workspaceId: usageSamples.workspaceId,
        ts: usageSamples.ts,
        cpuCoreSec: usageSamples.cpuCoreSec,
        runtimeSec: usageSamples.runtimeSec,
      })
      .from(usageSamples)
      .where(gt(usageSamples.ts, new Date(now.getTime() - STATS_MAX_AGE_MS)))
      .orderBy(usageSamples.workspaceId, desc(usageSamples.ts)),
    database
      .select({
        id: images.id,
        imageId: images.imageId,
        t3Ref: images.t3Ref,
        status: images.status,
      })
      .from(images),
  ]);
  const index = indexHostStats(stats[0]?.payload, stats[0]?.updatedAt, now);
  const sampleByWs = new Map(samples.map((s) => [s.workspaceId, s]));
  return rows.map(({ w, email, plan }) =>
    buildRackRow({
      slug: w.slug,
      ownerEmail: email,
      planName: plan?.name ?? null,
      status: w.status,
      slot: w.slot,
      lastActivityAt: w.lastActivityAt,
      awakeSince: w.awakeSince,
      plan: plan ? planLimits(plan) : null,
      host: index?.byWorkspace.get(w.slug),
      cpuCores: cpuCoresFromFreshSample(sampleByWs.get(w.id), now),
      image: {
        shortId: w.imageId ? w.imageId.slice(0, 12) : null,
        t3Ref: imageRows.find((i) => i.imageId !== null && i.imageId === w.imageId)?.t3Ref ?? null,
        state: workspaceImageState(w, imageRows),
      },
    }),
  );
}

/**
 * `usage_samples` of one workspace bucketed with `date_bin` (UTC-aligned), then padded to a linear
 * axis. The bucket width comes from the fixed USAGE_RANGES table, never from input.
 */
export async function loadUsageSeries(
  database: DbLike,
  workspaceId: string,
  range: UsageRange,
  now: Date = new Date(),
): Promise<UsageChartPoint[]> {
  const { spanMs, bucketMin } = USAGE_RANGES[range];
  const from = new Date(now.getTime() - spanMs);
  const bucket = sql<Date>`date_bin(${sql.raw(`interval '${bucketMin} minutes'`)}, ${usageSamples.ts}, timestamptz '2000-01-01 00:00:00+00')`;
  const rows = await database
    .select({
      bucket,
      runtimeSec: sql<number>`sum(${usageSamples.runtimeSec})`,
      cpuCoreSec: sql<number>`sum(${usageSamples.cpuCoreSec})`,
      memGbSec: sql<number>`sum(${usageSamples.memGbSec})`,
      chargeMicro: sql<string>`sum(${usageSamples.chargeMicro})::text`,
    })
    .from(usageSamples)
    .where(
      and(
        eq(usageSamples.workspaceId, workspaceId),
        gte(usageSamples.ts, from),
        lte(usageSamples.ts, now),
      ),
    )
    .groupBy(bucket)
    .orderBy(bucket);
  const raw: UsagePointRaw[] = rows.map((r) => ({
    t: new Date(r.bucket).getTime(),
    runtimeSec: Number(r.runtimeSec),
    cpuCoreSec: Number(r.cpuCoreSec),
    memGbSec: Number(r.memGbSec),
    chargeMicro: BigInt(r.chargeMicro),
  }));
  return fillUsageBuckets(raw, from, now, bucketMin);
}
