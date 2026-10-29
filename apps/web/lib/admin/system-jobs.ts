import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { JOB_TYPES, images, jobs, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { Db } from "../db-types";
import { UserError } from "../errors";

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobType = (typeof JOB_TYPES)[number];
export { JOB_TYPES };

export const JOBS_PAGE_SIZE = 50;

export interface JobFilters {
  status?: JobStatus;
  type?: JobType;
  /** Workspace slug (exact). */
  ws?: string;
  page: number;
}

/** Parses untrusted search params; unknown values are dropped rather than erroring. */
export function parseJobFilters(params: Record<string, string | string[] | undefined>): JobFilters {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const status = JOB_STATUSES.find((s) => s === one("status"));
  const type = JOB_TYPES.find((t) => t === one("type"));
  const ws = one("ws")?.toLowerCase().slice(0, 40);
  const page = Math.max(0, Number.parseInt(one("page") ?? "0", 10) || 0);
  return { status, type, ws, page };
}

export async function listJobs(db: Db, f: JobFilters) {
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(jobs.status, f.status));
  if (f.type) conds.push(eq(jobs.type, f.type));
  if (f.ws) conds.push(eq(workspaces.slug, f.ws));
  const rows = await db
    .select({ job: jobs, slug: workspaces.slug })
    .from(jobs)
    .leftJoin(workspaces, eq(workspaces.id, jobs.workspaceId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(JOBS_PAGE_SIZE + 1)
    .offset(f.page * JOBS_PAGE_SIZE);
  return { rows: rows.slice(0, JOBS_PAGE_SIZE), hasNext: rows.length > JOBS_PAGE_SIZE };
}

interface Actor {
  id: string;
  email: string;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const cause = (e as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || cause === "23505";
}

/**
 * Requeue a failed job. The partial unique index `jobs_active_ws_type_uq` allows one queued/running job
 * per workspace and type, so a retry is refused when a newer one is already active. Jobs without a
 * workspace are not covered by that index, so those are checked by hand.
 */
export async function retryJob(
  database: Db,
  input: { jobId: string; admin: Actor; ip: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  try {
    await database.transaction(async (tx) => {
      const job = (await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update"))[0];
      if (!job) throw new UserError("That job no longer exists");
      if (job.status !== "failed") {
        throw new UserError(`Only failed jobs can be retried; this one is ${job.status}`);
      }
      if (job.type === "build_image") {
        throw new UserError("Start a new build from the Images page instead of retrying this one");
      }
      if (job.workspaceId) {
        const active = (
          await tx
            .select({ status: jobs.status })
            .from(jobs)
            .where(
              and(
                eq(jobs.workspaceId, job.workspaceId),
                eq(jobs.type, job.type),
                inArray(jobs.status, ["queued", "running"]),
              ),
            )
            .limit(1)
        )[0];
        if (active) {
          throw new UserError(
            `A ${job.type.replaceAll("_", " ")} job for this workspace is already ${active.status}. Wait for it to finish or cancel it, then retry.`,
          );
        }
      } else if (job.type === "delete_image") {
        const imageRowId = (job.payload as { imageRowId?: string } | null)?.imageRowId;
        const dup = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "delete_image"),
              inArray(jobs.status, ["queued", "running"]),
              sql`${jobs.payload}->>'imageRowId' = ${imageRowId ?? ""}`,
            ),
          )
          .limit(1);
        if (dup.length > 0) throw new UserError("This image already has a delete job waiting");
      }
      await tx
        .update(jobs)
        .set({
          status: "queued",
          attempts: 0,
          runAfter: now,
          lastError: null,
          result: null,
          finishedAt: null,
        })
        .where(eq(jobs.id, job.id));
      await writeAudit(tx, {
        actorId: input.admin.id,
        action: "job.retry",
        targetType: "job",
        targetId: job.id,
        metadata: {
          type: job.type,
          workspaceId: job.workspaceId,
          previousAttempts: job.attempts,
          previousError: job.lastError,
        },
        ip: input.ip,
      });
    });
  } catch (e) {
    // Lost a race with something that enqueued the same job between our check and the update.
    if (isUniqueViolation(e)) {
      throw new UserError(
        "Another job of this type was just queued for this workspace. Reload and check Jobs.",
      );
    }
    throw e;
  }
}

/**
 * Cancel a queued job by marking it failed. Running jobs cannot be interrupted, and a cancelled
 * image build also fails its image row so the Images page stops waiting for it.
 */
export async function cancelJob(
  database: Db,
  input: { jobId: string; admin: Actor; ip: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await database.transaction(async (tx) => {
    const job = (await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update"))[0];
    if (!job) throw new UserError("That job no longer exists");
    if (job.status !== "queued") {
      throw new UserError(
        job.status === "running"
          ? "This job is already running and cannot be cancelled"
          : `Only queued jobs can be cancelled; this one is ${job.status}`,
      );
    }
    const message = `Cancelled by ${input.admin.email}`;
    await tx
      .update(jobs)
      .set({ status: "failed", lastError: message, finishedAt: now })
      .where(eq(jobs.id, job.id));
    if (job.type === "build_image") {
      const imageRowId = (job.payload as { imageRowId?: string } | null)?.imageRowId;
      if (imageRowId) {
        await tx
          .update(images)
          .set({ status: "failed", buildLog: message })
          .where(and(eq(images.id, imageRowId), eq(images.status, "building")));
      }
    }
    await writeAudit(tx, {
      actorId: input.admin.id,
      action: "job.cancel",
      targetType: "job",
      targetId: job.id,
      metadata: { type: job.type, workspaceId: job.workspaceId },
      ip: input.ip,
    });
  });
}
