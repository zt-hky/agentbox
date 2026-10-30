import { and, asc, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { decrypt } from "@agentbox/core";
import {
  CONTAINER_UP_STATUSES,
  WORKSPACE_GONE_STATUSES,
  isImageUsable,
} from "@agentbox/core/images";
import {
  fetchLogsPayloadSchema,
  type FetchLogsResult,
  type InspectWorkspaceResult,
} from "@agentbox/core/job-contracts";
import {
  agentKeys,
  images,
  jobs,
  plans,
  subscriptions,
  workspaceSessions,
  workspaces,
} from "@agentbox/db/schema";
import { AgentError } from "./agent-client.ts";
import { errMessage } from "./log.ts";
import { startCopilotLogin } from "./accounts.ts";
import { reconcileGit } from "./git.ts";
import { addEvent, enqueueJob } from "./queue.ts";
import { reconcileAfterStart, reconcileToolchain } from "./toolchain.ts";
import type { Ctx } from "./types.ts";

export const MAX_ATTEMPTS = 3;
export const MAX_CONCURRENT = 4;
export const POLL_MS = 1000;
export const BUILD_LOG_POLL_MS = 5000;
const ROOTFS_DIR = "/srv/agentbox/rootfs";

export type JobRow = typeof jobs.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

/** Failing this way skips the retry budget (e.g. a 2 h image build must not rerun 3 times). */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** A handler may return a value; it is stored in `jobs.result` (diagnostic jobs). */
type Handler = (ctx: Ctx, job: JobRow) => Promise<unknown>;

function requireRunning(ws: WorkspaceRow): void {
  if (ws.status !== "running") throw new NonRetryableError(`workspace ${ws.slug} is not running`);
}

/** Diagnostics are point-in-time snapshots: any failure is final (never retried). */
function diagnostic(handler: Handler): Handler {
  return async (ctx, job) => {
    try {
      return await handler(ctx, job);
    } catch (e) {
      throw e instanceof NonRetryableError ? e : new NonRetryableError(errMessage(e));
    }
  };
}

const stopPayloadSchema = z.object({
  reason: z.enum([
    "idle",
    "max_awake",
    "credits_exhausted",
    "daily_limit",
    "trial_ended",
    "user",
    "admin",
    "suspended",
  ]),
});
const buildPayloadSchema = z.object({
  imageRowId: z.uuid(),
  t3Ref: z.string().min(1),
});
const deletePayloadSchema = z.object({ keepData: z.boolean().optional() });
const deleteImagePayloadSchema = z.object({ imageRowId: z.uuid() });

async function loadTenant(ctx: Ctx, job: JobRow) {
  if (!job.workspaceId) throw new NonRetryableError(`${job.type} job has no workspaceId`);
  const [row] = await ctx.db
    .select({ ws: workspaces, plan: plans })
    .from(workspaces)
    .leftJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(workspaces.id, job.workspaceId));
  if (!row) throw new NonRetryableError(`workspace ${job.workspaceId} not found`);
  return row;
}

function limitsOf(plan: typeof plans.$inferSelect | null, slug: string) {
  if (!plan) throw new Error(`workspace ${slug} has no subscription plan`);
  return {
    diskGb: plan.diskLimitGb,
    limits: {
      cpus: Number(plan.cpuLimit),
      memoryMb: plan.memoryLimitMb,
      pidsLimit: plan.pidsLimit,
      inodes: plan.inodesLimit,
    },
  };
}

/**
 * Write the user's saved agent credentials into the running workspace (`~/.agentbox/secrets.env`,
 * replaced as a whole). A workspace that is not running picks them up on its next start.
 */
export async function syncAgentKeys(ctx: Ctx, ws: WorkspaceRow): Promise<void> {
  if (ws.status !== "running") return;
  const rows = await ctx.db.select().from(agentKeys).where(eq(agentKeys.userId, ws.userId));
  const keys: Record<string, string> = {};
  for (const r of rows) keys[r.envVar] = decrypt(r.valueEnc, ctx.config.encryptionKey);
  try {
    await ctx.agent.syncAgentKeys(ws.slug, { keys });
  } catch (e) {
    // 409: the container is not running (anymore); the next start syncs.
    if (e instanceof AgentError && e.status === 409) return;
    throw e;
  }
}

async function tailBuildLog(ctx: Ctx, jobId: string, imageRowId: string): Promise<string | null> {
  try {
    const log = await ctx.agent.buildLog(jobId, 200);
    await ctx.db.update(images).set({ buildLog: log }).where(eq(images.id, imageRowId));
    return log;
  } catch {
    return null; // log may not exist yet; never fail the build because of tailing
  }
}

/** The image a workspace starts from: its admin pin when set, otherwise the active image. */
async function resolveStartImage(ctx: Ctx, ws: WorkspaceRow): Promise<{ imageId: string }> {
  if (ws.pinnedImageId) {
    const [pinned] = await ctx.db.select().from(images).where(eq(images.id, ws.pinnedImageId));
    if (!pinned || !isImageUsable(pinned))
      throw new NonRetryableError(
        `pinned image is not usable (${pinned?.status ?? "missing"}); pick another image or follow the active one`,
      );
    return { imageId: pinned.imageId as string };
  }
  const [image] = await ctx.db.select().from(images).where(eq(images.status, "active"));
  if (!image?.imageId)
    throw new Error("no active workspace image; activate one in the admin console");
  return { imageId: image.imageId };
}

async function startWorkspace(
  ctx: Ctx,
  ws: WorkspaceRow,
  plan: typeof plans.$inferSelect | null,
): Promise<void> {
  await ctx.db.update(workspaces).set({ status: "starting" }).where(eq(workspaces.id, ws.id));
  try {
    const image = await resolveStartImage(ctx, ws);
    const { limits } = limitsOf(plan, ws.slug);
    await ctx.agent.startWorkspace(ws.slug, {
      imageId: image.imageId,
      slot: ws.slot,
      limits,
      env: {
        T3CODE_GATEWAY_IDENTITY_SECRET: decrypt(ws.identitySecretEnc, ctx.config.encryptionKey),
        T3CODE_GATEWAY_IDENTITY_AUDIENCE: ws.slug,
        T3CODE_INSTANCE_NAME: ws.slug,
        T3CODE_VSCODE_WEB_URL: `https://${ws.slug}-code.${ctx.config.baseDomain}`,
      },
    });
    const now = ctx.now();
    await ctx.db
      .update(workspaces)
      .set({
        status: "running",
        imageId: image.imageId,
        awakeSince: now,
        lastActivityAt: now,
        lastCpuUsec: 0n,
        startFailures: 0,
      })
      .where(eq(workspaces.id, ws.id));
    await addEvent(ctx.db, ws.id, "started", {
      imageId: image.imageId,
      ...(ws.pinnedImageId ? { pinned: true } : {}),
    });
  } catch (e) {
    await ctx.db
      .update(workspaces)
      .set({ status: "error", startFailures: sql`${workspaces.startFailures} + 1` })
      .where(eq(workspaces.id, ws.id));
    await addEvent(ctx.db, ws.id, "start_failed", { error: errMessage(e) });
    throw e;
  }
  if (ws.gitSyncPending) {
    const [fresh] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    if (fresh) {
      try {
        await reconcileGit(ctx, fresh);
      } catch (e) {
        ctx.log.warn("git reconcile after start failed", { ws: ws.slug, error: errMessage(e) });
      }
    }
  }
  const [fresh] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ws.id));
  if (fresh) {
    try {
      await syncAgentKeys(ctx, fresh);
    } catch (e) {
      ctx.log.warn("agent key sync after start failed", { ws: ws.slug, error: errMessage(e) });
    }
  }
  await reconcileAfterStart(ctx, ws.id);
}

async function stopWorkspace(
  ctx: Ctx,
  ws: WorkspaceRow,
  reason: z.infer<typeof stopPayloadSchema>["reason"] | "restart",
): Promise<void> {
  await ctx.db.update(workspaces).set({ status: "stopping" }).where(eq(workspaces.id, ws.id));
  try {
    await ctx.agent.stopWorkspace(ws.slug);
  } catch (e) {
    // 404: no tenant exists on the host, so nothing can be running. Anything else is a real failure.
    if (!(e instanceof AgentError && e.status === 404)) {
      await ctx.db.update(workspaces).set({ status: "error" }).where(eq(workspaces.id, ws.id));
      throw e;
    }
  }
  await ctx.db
    .update(workspaces)
    .set({ status: "sleeping", awakeSince: null })
    .where(eq(workspaces.id, ws.id));
  await addEvent(ctx.db, ws.id, "stopped", { reason });
}

export const handlers: Record<JobRow["type"], Handler> = {
  async provision_tenant(ctx, job) {
    const { ws, plan } = await loadTenant(ctx, job);
    if (ws.status === "deleting" || ws.status === "deleted") return;
    const { diskGb, limits } = limitsOf(plan, ws.slug);
    await ctx.agent.createTenant({ ws: ws.slug, slot: ws.slot, diskGb, limits });
    await ctx.db
      .update(workspaces)
      .set({ status: "sleeping" })
      .where(and(eq(workspaces.id, ws.id), eq(workspaces.status, "provisioning")));
    // Onboarding creates the workspace with the toolchain pending: bring it up straight away so
    // the chosen tools install (the start hook queues the reconcile).
    if (ws.toolchainPending)
      await enqueueJob(ctx.db, { type: "start_workspace", workspaceId: ws.id });
  },

  async start_workspace(ctx, job) {
    const { ws, plan } = await loadTenant(ctx, job);
    if (ws.status === "deleting" || ws.status === "deleted" || ws.status === "provisioning") return;
    if (ws.status === "running") return;
    await startWorkspace(ctx, ws, plan);
  },

  async stop_workspace(ctx, job) {
    const { reason } = stopPayloadSchema.parse(job.payload);
    const { ws } = await loadTenant(ctx, job);
    if (["sleeping", "provisioning", "deleting", "deleted"].includes(ws.status)) return;
    await stopWorkspace(ctx, ws, reason);
  },

  async restart_workspace(ctx, job) {
    const { ws, plan } = await loadTenant(ctx, job);
    if (ws.status === "deleting" || ws.status === "deleted" || ws.status === "provisioning") return;
    if (ws.status !== "sleeping") await stopWorkspace(ctx, ws, "restart");
    await startWorkspace(ctx, ws, plan);
  },

  fetch_logs: diagnostic(async (ctx, job): Promise<FetchLogsResult> => {
    const { tail } = fetchLogsPayloadSchema.parse(job.payload);
    const { ws } = await loadTenant(ctx, job);
    requireRunning(ws);
    const { log } = await ctx.agent.workspaceLogs(ws.slug, tail);
    return { log, fetchedAt: ctx.now().toISOString() };
  }),

  inspect_workspace: diagnostic(async (ctx, job): Promise<InspectWorkspaceResult> => {
    const { ws } = await loadTenant(ctx, job);
    requireRunning(ws);
    const top = await ctx.agent.workspaceTop(ws.slug);
    return {
      running: true,
      startedAt: top.startedAt,
      processes: top.processes,
      fetchedAt: ctx.now().toISOString(),
    };
  }),

  async delete_tenant(ctx, job) {
    const { ws } = await loadTenant(ctx, job);
    if (ws.status === "deleted") return;
    const { keepData } = deletePayloadSchema.parse(job.payload ?? {});
    await ctx.db.update(workspaces).set({ status: "deleting" }).where(eq(workspaces.id, ws.id));
    await ctx.agent.deleteTenant(ws.slug, { keepData: keepData === true });
    await ctx.db
      .update(workspaces)
      .set({ status: "deleted", awakeSince: null, dataKept: keepData === true })
      .where(eq(workspaces.id, ws.id));
    await ctx.db
      .update(workspaceSessions)
      .set({ revokedAt: ctx.now() })
      .where(eq(workspaceSessions.workspaceId, ws.id));
  },

  async sync_git(ctx, job) {
    const { ws } = await loadTenant(ctx, job);
    if (ws.status === "deleted" || ws.status === "deleting") return;
    await reconcileGit(ctx, ws);
  },

  async sync_agent_keys(ctx, job) {
    const { ws } = await loadTenant(ctx, job);
    if (ws.status === "deleted" || ws.status === "deleting") return;
    await syncAgentKeys(ctx, ws);
  },

  async copilot_login(ctx, job) {
    const { ws } = await loadTenant(ctx, job);
    if (ws.status === "deleted" || ws.status === "deleting") return;
    await startCopilotLogin(ctx, ws);
  },

  async update_limits(ctx, job) {
    const { ws, plan } = await loadTenant(ctx, job);
    if (ws.status === "deleted" || ws.status === "deleting" || ws.status === "provisioning") return;
    await ctx.agent.updateLimits(ws.slug, limitsOf(plan, ws.slug));
  },

  async build_image(ctx, job) {
    const { imageRowId, t3Ref } = buildPayloadSchema.parse(job.payload);
    const [imageRow] = await ctx.db.select().from(images).where(eq(images.id, imageRowId));
    if (!imageRow) throw new NonRetryableError(`image row ${imageRowId} not found`);
    const timer = setInterval(() => void tailBuildLog(ctx, job.id, imageRowId), BUILD_LOG_POLL_MS);
    try {
      const out = await ctx.agent.buildImage({
        jobId: job.id,
        t3Ref,
        version: imageRow.version,
      });
      const log = await tailBuildLog(ctx, job.id, imageRowId);
      await ctx.db
        .update(images)
        .set({
          imageId: out.imageId,
          rootfsPath: `${ROOTFS_DIR}/${out.imageId}`,
          scanSummary: out.scanSummary,
          ...(out.manifest ? { manifest: out.manifest } : {}),
          status: "ready",
          ...(log === null ? {} : { buildLog: log }),
        })
        .where(eq(images.id, imageRowId));
    } catch (e) {
      const log = await tailBuildLog(ctx, job.id, imageRowId);
      await ctx.db
        .update(images)
        .set({ status: "failed", buildLog: log ?? errMessage(e) })
        .where(eq(images.id, imageRowId));
      throw new NonRetryableError(errMessage(e));
    } finally {
      clearInterval(timer);
    }
  },

  async delete_image(ctx, job) {
    const { imageRowId } = deleteImagePayloadSchema.parse(job.payload);
    const [row] = await ctx.db.select().from(images).where(eq(images.id, imageRowId));
    if (!row) return;
    if (row.status === "active") throw new NonRetryableError("refusing to delete the active image");
    const pinnedBy = await ctx.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.pinnedImageId, row.id),
          notInArray(workspaces.status, [...WORKSPACE_GONE_STATUSES]),
        ),
      );
    if (pinnedBy.length > 0)
      throw new NonRetryableError(
        `image is pinned by workspaces: ${pinnedBy.map((w) => w.slug).join(", ")}`,
      );
    if (row.imageId) {
      const running = await ctx.db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.imageId, row.imageId),
            inArray(workspaces.status, [...CONTAINER_UP_STATUSES]),
          ),
        );
      if (running.length > 0)
        throw new NonRetryableError(
          `image is in use by running workspaces: ${running.map((w) => w.slug).join(", ")}`,
        );
      await ctx.agent.deleteImage(row.imageId);
    }
    // Keep the row (and its build log) for audit; a null rootfsPath marks the files as gone.
    await ctx.db
      .update(images)
      .set({ status: "retired", rootfsPath: null })
      .where(eq(images.id, imageRowId));
  },

  reconcile_toolchain: (ctx, job) => reconcileToolchain(ctx, job),
};

export class JobRunner {
  private readonly inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: { maxConcurrent?: number; pollMs?: number } = {},
  ) {}

  /** Jobs left `running` by a crashed worker would block their dedupe slot forever. */
  async recoverRunning(): Promise<number> {
    const rows = await this.ctx.db
      .update(jobs)
      .set({ status: "queued", runAfter: this.ctx.now() })
      .where(eq(jobs.status, "running"))
      .returning({ id: jobs.id });
    return rows.length;
  }

  /** Claim up to `limit` due jobs in one tx, at most one per workspace and none for a busy workspace. */
  async claim(limit: number): Promise<JobRow[]> {
    if (limit <= 0) return [];
    return this.ctx.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, this.ctx.now())))
        .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
        .limit(limit * 8)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) return [];
      const busy = new Set(
        (
          await tx
            .select({ w: jobs.workspaceId })
            .from(jobs)
            .where(and(eq(jobs.status, "running"), isNotNull(jobs.workspaceId)))
        ).map((r) => r.w),
      );
      const picked: JobRow[] = [];
      for (const c of candidates) {
        if (picked.length >= limit) break;
        if (c.workspaceId) {
          if (busy.has(c.workspaceId)) continue;
          busy.add(c.workspaceId);
        }
        picked.push(c);
      }
      if (picked.length === 0) return [];
      return tx
        .update(jobs)
        .set({ status: "running", attempts: sql`${jobs.attempts} + 1` })
        .where(
          inArray(
            jobs.id,
            picked.map((p) => p.id),
          ),
        )
        .returning();
    });
  }

  private async execute(job: JobRow): Promise<void> {
    const { ctx } = this;
    try {
      const result = await handlers[job.type](ctx, job);
      await ctx.db
        .update(jobs)
        .set({
          status: "done",
          lastError: null,
          result: result === undefined ? null : result,
          finishedAt: ctx.now(),
        })
        .where(eq(jobs.id, job.id));
    } catch (e) {
      const message = errMessage(e);
      const final = e instanceof NonRetryableError || job.attempts >= MAX_ATTEMPTS;
      ctx.log.warn("job failed", {
        job: job.id,
        type: job.type,
        attempts: job.attempts,
        final,
        error: message,
      });
      try {
        await ctx.db
          .update(jobs)
          .set(
            final
              ? { status: "failed", lastError: message, finishedAt: ctx.now() }
              : {
                  status: "queued",
                  lastError: message,
                  runAfter: new Date(ctx.now().getTime() + 2 ** job.attempts * 5000),
                },
          )
          .where(eq(jobs.id, job.id));
      } catch (e2) {
        ctx.log.error("could not record job failure", { job: job.id, error: errMessage(e2) });
      }
    }
  }

  /** Claim what fits and start running it; resolves once the jobs are launched (not finished). */
  async tick(): Promise<number> {
    if (this.stopping) return 0;
    const claimed = await this.claim(
      (this.opts.maxConcurrent ?? MAX_CONCURRENT) - this.inflight.size,
    );
    for (const job of claimed) {
      const p: Promise<void> = this.execute(job).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
    return claimed.length;
  }

  /** Resolves when every launched job has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  start(): void {
    const loop = () => {
      this.timer = null;
      if (this.stopping) return;
      this.tick()
        .catch((e) => this.ctx.log.error("job poll failed", { error: errMessage(e) }))
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(loop, this.opts.pollMs ?? POLL_MS);
        });
    };
    loop();
  }

  /** Stop claiming; wait up to `graceMs` for in-flight jobs. Returns how many were still running. */
  async stop(graceMs: number): Promise<number> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    let t: NodeJS.Timeout | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((r) => {
        t = setTimeout(r, graceMs);
      }),
    ]);
    clearTimeout(t);
    return this.inflight.size;
  }
}
