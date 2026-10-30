import { and, desc, eq, inArray } from "drizzle-orm";
import {
  buildPlan,
  catalogEntry,
  parseImageManifest,
  parseVersionOutput,
  toAgentStep,
  verifySteps,
  type AgentStep,
  type LatestInfo,
  type Plan,
  type PlanStep,
  type StepRecord,
  type ToolId,
  type ToolState,
  type ToolchainResult,
} from "@agentbox/core/toolchain";
import { images, toolLatest, toolchainRuns, workspaceTools, workspaces } from "@agentbox/db/schema";
import {
  bakedToolsFor,
  loadToolchainSettings,
  requestReconcile,
  seedWorkspaceTools,
} from "@agentbox/db/toolchain";
import { AgentError } from "./agent-client.ts";
import { loadStartGate, startBlockReason } from "./billing.ts";
import { NonRetryableError, type JobRow } from "./jobs.ts";
import { errMessage } from "./log.ts";
import { enqueueJob } from "./queue.ts";
import type { Ctx } from "./types.ts";

/** Tunables the tests override; production uses the defaults. */
export const toolchainTuning = {
  /** Delay between polls of a running agent run. */
  pollMs: 2000,
  /** An agent run that takes longer is cancelled. */
  runTimeoutMs: 30 * 60_000,
};

export const LOG_CAP_BYTES = 256 * 1024;
export const MAX_RUN_ATTEMPTS = 3;
/** Passes of one job when the desired state keeps changing underneath it. */
const MAX_PASSES = 5;

type WorkspaceRow = typeof workspaces.$inferSelect;
type ToolRow = typeof workspaceTools.$inferSelect;
type RunRow = typeof toolchainRuns.$inferSelect;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep the newest `LOG_CAP_BYTES` of a log (cut on a line boundary when one is near). */
export function capLog(log: string): string {
  if (Buffer.byteLength(log) <= LOG_CAP_BYTES) return log;
  const tail = Buffer.from(log).subarray(-LOG_CAP_BYTES).toString("utf8");
  const nl = tail.indexOf("\n");
  return nl >= 0 && nl < 512 ? tail.slice(nl + 1) : tail;
}

function isKnownTool(id: string): id is ToolId {
  return catalogEntry(id) !== undefined;
}

/** Outcome of driving one agent run. */
type AgentOutcome =
  | { kind: "finished"; result: ToolchainResult | null; steps: StepRecord[] }
  | { kind: "interrupted" }
  | { kind: "timeout"; steps: StepRecord[] };

/** Thrown by `driveAgentRun` when the agent refuses the plan outright (422 no mise, 507 quota). */
class AgentRefusedError extends Error {}

interface RunState {
  /** In-memory copy of `toolchain_runs.log` (capped). */
  log: string;
  /** Step records of earlier passes of this run. */
  steps: StepRecord[];
  ok: number;
  failed: number;
  errors: string[];
  plan: Plan | null;
}

async function pickRun(ctx: Ctx, ws: WorkspaceRow, jobId: string): Promise<RunRow> {
  const open = await ctx.db
    .select()
    .from(toolchainRuns)
    .where(
      and(
        eq(toolchainRuns.workspaceId, ws.id),
        inArray(toolchainRuns.status, ["queued", "waiting", "running", "interrupted"]),
      ),
    )
    .orderBy(desc(toolchainRuns.createdAt));
  const [newest, ...older] = open;
  if (!newest) {
    const [created] = await ctx.db
      .insert(toolchainRuns)
      .values({
        workspaceId: ws.id,
        jobId,
        trigger: "start",
        status: "queued",
        generation: ws.toolchainGeneration,
      })
      .returning();
    if (!created) throw new Error("could not create toolchain run");
    return created;
  }
  let run = newest;
  if (older.length > 0) {
    // A newer request superseded runs that never finished; the interruption budget carries over.
    const attempts = Math.max(newest.attempts, ...older.map((o) => o.attempts));
    await ctx.db
      .update(toolchainRuns)
      .set({ status: "cancelled", error: "superseded by a newer run", finishedAt: ctx.now() })
      .where(
        inArray(
          toolchainRuns.id,
          older.map((o) => o.id),
        ),
      );
    run = { ...newest, attempts };
  }
  await ctx.db
    .update(toolchainRuns)
    .set({ jobId, attempts: run.attempts })
    .where(eq(toolchainRuns.id, run.id));
  return run;
}

async function finishRun(
  ctx: Ctx,
  run: RunRow,
  status: RunRow["status"],
  st: RunState,
  error: string | null,
  extra: Partial<typeof toolchainRuns.$inferInsert> = {},
): Promise<void> {
  await ctx.db
    .update(toolchainRuns)
    .set({
      status,
      error,
      plan: st.plan,
      steps: st.steps,
      log: st.log,
      finishedAt: ctx.now(),
      ...extra,
    })
    .where(eq(toolchainRuns.id, run.id));
}

const emptyState = (run: RunRow): RunState => ({
  log: run.log ?? "",
  steps: [],
  ok: 0,
  failed: 0,
  errors: [],
  plan: null,
});

/**
 * `reconcile_toolchain`: bring the workspace's installed tools in line with its desired state.
 * A sleeping workspace is started first (normal start path, normal billing); the start hook
 * enqueues this job again once the container is up.
 */
export async function reconcileToolchain(ctx: Ctx, job: JobRow): Promise<void> {
  if (!job.workspaceId) throw new NonRetryableError("reconcile_toolchain job has no workspaceId");
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, job.workspaceId));
  if (!ws) return;
  if (ws.status === "deleting" || ws.status === "deleted") {
    await ctx.db
      .update(toolchainRuns)
      .set({ status: "cancelled", error: "workspace was deleted", finishedAt: ctx.now() })
      .where(
        and(
          eq(toolchainRuns.workspaceId, ws.id),
          inArray(toolchainRuns.status, ["queued", "waiting", "running", "interrupted"]),
        ),
      );
    return;
  }

  const [anyTool] = await ctx.db
    .select({ toolId: workspaceTools.toolId })
    .from(workspaceTools)
    .where(eq(workspaceTools.workspaceId, ws.id))
    .limit(1);
  if (!anyTool) {
    await seedWorkspaceTools(ctx.db, ws.id, {
      defaults: (await loadToolchainSettings(ctx.db)).defaults,
      baked: await bakedToolsFor(ctx.db, ws),
    });
  }

  switch (ws.status) {
    case "running":
      return drain(ctx, job, ws);
    case "sleeping":
    case "error":
      return autoStart(ctx, job, ws);
    case "starting":
    case "stopping":
      throw new Error(`workspace ${ws.slug} is ${ws.status}; retrying the toolchain run later`);
    default:
      throw new NonRetryableError(`workspace ${ws.slug} is ${ws.status}`);
  }
}

/** Sleeping workspace: apply the billing gate, then start it; the start hook resumes the run. */
async function autoStart(ctx: Ctx, job: JobRow, ws: WorkspaceRow): Promise<void> {
  const run = await pickRun(ctx, ws, job.id);
  const reason = startBlockReason(await loadStartGate(ctx, ws.userId));
  if (reason) {
    await ctx.db
      .update(workspaces)
      .set({ toolchainPending: false })
      .where(eq(workspaces.id, ws.id));
    await finishRun(
      ctx,
      run,
      "failed",
      emptyState(run),
      `The workspace could not be started to apply the toolchain: ${reason}.`,
    );
    return;
  }
  await ctx.db.update(workspaces).set({ toolchainPending: true }).where(eq(workspaces.id, ws.id));
  await ctx.db.update(toolchainRuns).set({ status: "waiting" }).where(eq(toolchainRuns.id, run.id));
  await enqueueJob(ctx.db, { type: "start_workspace", workspaceId: ws.id });
}

/**
 * Called after a workspace started: resume a waiting run, or reconcile a workspace that was never
 * reconciled on an image that ships mise. Failures are logged, never fail the start.
 */
export async function reconcileAfterStart(ctx: Ctx, workspaceId: string): Promise<void> {
  try {
    const [fresh] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!fresh) return;
    let trigger: "start" | "defaults" | null = fresh.toolchainPending ? "start" : null;
    if (!trigger && fresh.toolchainReconciledAt === null && fresh.imageId) {
      const [img] = await ctx.db
        .select({ manifest: images.manifest })
        .from(images)
        .where(eq(images.imageId, fresh.imageId))
        .limit(1);
      if (parseImageManifest(img?.manifest)?.mise) trigger = "defaults";
    }
    if (!trigger) return;
    await requestReconcile(ctx.db, { workspaceId, trigger });
    if (fresh.toolchainPending) {
      await ctx.db
        .update(workspaces)
        .set({ toolchainPending: false })
        .where(eq(workspaces.id, workspaceId));
    }
  } catch (e) {
    ctx.log.warn("toolchain reconcile after start failed", {
      ws: workspaceId,
      error: errMessage(e),
    });
  }
}

/** Drive runs until the desired generation is applied. */
async function drain(ctx: Ctx, job: JobRow, wsStart: WorkspaceRow): Promise<void> {
  const run = await pickRun(ctx, wsStart, job.id);
  const st = emptyState(run);
  await ctx.db
    .update(toolchainRuns)
    .set({
      status: "running",
      startedAt: run.startedAt ?? ctx.now(),
      error: null,
      finishedAt: null,
    })
    .where(eq(toolchainRuns.id, run.id));

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, wsStart.id));
    if (!ws) return;
    const generation = ws.toolchainGeneration;
    await ctx.db
      .update(workspaces)
      .set({ toolchainPending: false })
      .where(eq(workspaces.id, ws.id));

    let outcome: "settled" | "interrupted";
    try {
      outcome = await runPass(ctx, ws, run, st, pass);
    } catch (e) {
      if (e instanceof AgentRefusedError) {
        await finishRun(ctx, run, "failed", st, e.message);
        await ctx.db
          .update(workspaces)
          .set({ toolchainPending: false })
          .where(eq(workspaces.id, ws.id));
        throw new NonRetryableError(e.message);
      }
      throw e;
    }
    if (outcome === "interrupted") {
      const attempts = run.attempts + 1;
      if (attempts >= MAX_RUN_ATTEMPTS) {
        await finishRun(
          ctx,
          run,
          "failed",
          st,
          `The toolchain run was interrupted ${attempts} times; the workspace stopped each time.`,
          { attempts },
        );
      } else {
        await finishRun(
          ctx,
          run,
          "interrupted",
          st,
          "The workspace stopped during the run; it resumes at the next start.",
          { attempts, finishedAt: null },
        );
        await ctx.db
          .update(workspaces)
          .set({ toolchainPending: true })
          .where(eq(workspaces.id, ws.id));
      }
      return;
    }

    const [after] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    const moved = !!after && after.toolchainGeneration > generation;
    if (!moved || after.status !== "running") {
      await settleRun(ctx, ws, run, st, generation, !moved);
      return;
    }
    // A change arrived during the run (requestReconcile reused this run): apply it too.
    await ctx.db
      .update(toolchainRuns)
      .set({ steps: st.steps, plan: st.plan, log: st.log })
      .where(eq(toolchainRuns.id, run.id));
    if (pass === MAX_PASSES) {
      await settleRun(ctx, ws, run, st, generation, false);
      throw new Error("the toolchain desired state kept changing; retrying later");
    }
  }
}

/** Final run status, workspace generation bookkeeping and ABI. */
async function settleRun(
  ctx: Ctx,
  ws: WorkspaceRow,
  run: RunRow,
  st: RunState,
  generation: number,
  complete: boolean,
): Promise<void> {
  const status: RunRow["status"] = st.failed === 0 ? "succeeded" : st.ok > 0 ? "partial" : "failed";
  const set: Partial<typeof workspaces.$inferInsert> = {
    toolchainAppliedGeneration: generation,
    toolchainPending: false,
  };
  if (st.failed === 0 && complete) set.toolchainReconciledAt = ctx.now();
  try {
    const state = await ctx.agent.toolchainState(ws.slug);
    if (state.image.toolchainAbi) set.toolchainAbi = state.image.toolchainAbi;
  } catch (e) {
    ctx.log.warn("could not read toolchain state", { ws: ws.slug, error: errMessage(e) });
  }
  await ctx.db.update(workspaces).set(set).where(eq(workspaces.id, ws.id));
  await finishRun(ctx, run, status, st, st.errors.length > 0 ? st.errors.join("\n") : null);
}

async function loadTools(ctx: Ctx, workspaceId: string): Promise<ToolRow[]> {
  const rows = await ctx.db
    .select()
    .from(workspaceTools)
    .where(eq(workspaceTools.workspaceId, workspaceId));
  return rows.filter((r) => isKnownTool(r.toolId));
}

async function loadLatest(ctx: Ctx): Promise<Partial<Record<ToolId, LatestInfo>>> {
  const out: Partial<Record<ToolId, LatestInfo>> = {};
  for (const r of await ctx.db.select().from(toolLatest)) {
    if (!isKnownTool(r.toolId)) continue;
    out[r.toolId] = { latest: r.latest, lts: r.lts, versions: r.versions, meta: r.meta };
  }
  return out;
}

async function setTool(
  ctx: Ctx,
  workspaceId: string,
  toolId: string,
  set: Partial<typeof workspaceTools.$inferInsert>,
): Promise<void> {
  await ctx.db
    .update(workspaceTools)
    .set({ ...set, updatedAt: ctx.now() })
    .where(and(eq(workspaceTools.workspaceId, workspaceId), eq(workspaceTools.toolId, toolId)));
}

/**
 * Start a run on the agent and follow it to the end. Logs and step records are mirrored to the run
 * row on every poll through `onProgress`. 409 / run state `interrupted` mean the container stopped.
 */
async function driveAgentRun(
  ctx: Ctx,
  slug: string,
  agentRunId: string,
  mode: "apply" | "check",
  steps: AgentStep[],
  onProgress: (chunk: string, records: StepRecord[]) => Promise<void>,
): Promise<AgentOutcome> {
  try {
    await ctx.agent.toolchainApply(slug, { runId: agentRunId, mode, steps });
  } catch (e) {
    if (e instanceof AgentError) {
      if (e.status === 409) return { kind: "interrupted" };
      if (e.status === 422 || e.status === 507) throw new AgentRefusedError(e.message);
    }
    throw e;
  }
  const started = performance.now();
  let offset = 0;
  for (;;) {
    let r;
    try {
      r = await ctx.agent.toolchainRun(slug, agentRunId, offset);
    } catch (e) {
      if (e instanceof AgentError && (e.status === 409 || e.status === 404))
        return { kind: "interrupted" };
      throw e;
    }
    offset = r.nextOffset;
    const records = r.steps;
    await onProgress(r.log, records);
    if (r.state === "finished")
      return { kind: "finished", result: r.result, steps: r.result?.steps ?? records };
    if (r.state === "interrupted" || r.state === "missing") return { kind: "interrupted" };
    if (performance.now() - started > toolchainTuning.runTimeoutMs) {
      try {
        await ctx.agent.toolchainCancel(slug, agentRunId);
      } catch (e) {
        ctx.log.warn("could not cancel toolchain run", { ws: slug, error: errMessage(e) });
      }
      return { kind: "timeout", steps: records };
    }
    await sleep(toolchainTuning.pollMs);
  }
}

/** One plan-and-apply pass. Returns `interrupted` when the container stopped. */
async function runPass(
  ctx: Ctx,
  ws: WorkspaceRow,
  run: RunRow,
  st: RunState,
  pass: number,
): Promise<"settled" | "interrupted"> {
  const idBase = `${run.id}-${run.attempts}-${pass}`;
  const progress =
    (extraSteps: () => StepRecord[]) => async (chunk: string, records: StepRecord[]) => {
      if (chunk) st.log = capLog(st.log + chunk);
      await ctx.db
        .update(toolchainRuns)
        .set({
          log: st.log,
          steps: [...st.steps, ...extraSteps(), ...records.filter((r) => r.action !== "verify")],
        })
        .where(eq(toolchainRuns.id, run.id));
    };

  let rows = await loadTools(ctx, ws.id);
  const latest = await loadLatest(ctx);

  // 1. Inspect what the image provides / what was never observed (one extra agent call).
  const toVerify = rows
    .filter((r) => r.state === "external" || r.observedAt === null)
    .map((r) => r.toolId as ToolId);
  if (toVerify.length > 0) {
    const verify = verifySteps(toVerify);
    let outcome: AgentOutcome;
    try {
      outcome = await driveAgentRun(
        ctx,
        ws.slug,
        `${idBase}c`,
        "check",
        verify.map((s) => toAgentStep(s, latest[s.tool])),
        progress(() => []),
      );
    } catch (e) {
      if (e instanceof AgentRefusedError) {
        for (const id of toVerify)
          await setTool(ctx, ws.id, id, { state: "failed", lastError: e.message });
      }
      throw e;
    }
    if (outcome.kind === "interrupted") return "interrupted";
    if (outcome.kind === "timeout") {
      st.failed++;
      st.errors.push("Checking the installed tools timed out.");
      return "settled";
    }
    const byTool = new Map(rows.map((r) => [r.toolId, r]));
    for (const rec of outcome.steps) {
      if (rec.action !== "verify" || !byTool.has(rec.tool)) continue;
      const row = byTool.get(rec.tool) as ToolRow;
      const observedAt = ctx.now();
      if (rec.status === "ok") {
        const version = parseVersionOutput(rec.observed ?? "") ?? rec.version ?? null;
        await setTool(ctx, ws.id, rec.tool, {
          observedAt,
          ...(row.state === "external" ? { installedVersion: version } : {}),
        });
      } else {
        await setTool(ctx, ws.id, rec.tool, {
          observedAt,
          ...(row.state === "external"
            ? { state: "pending" as const, installedVersion: null }
            : {}),
        });
      }
    }
    rows = await loadTools(ctx, ws.id);
  }

  // 2. Plan.
  const settings = await loadToolchainSettings(ctx.db);
  const wanted = (action: ToolRow["requestedAction"]) =>
    rows.filter((r) => r.requestedAction === action).map((r) => r.toolId as ToolId);
  const plan = buildPlan({
    desired: rows.map((r) => ({
      toolId: r.toolId,
      channel: r.channel,
      pinnedVersion: r.pinnedVersion,
      desired: r.desired,
    })),
    observed: rows.map((r) => ({
      toolId: r.toolId,
      state: r.state,
      installedVersion: r.installedVersion,
      previousVersion: r.previousVersion,
      backend: r.backend,
    })),
    latest,
    disabled: settings.disabled,
    upgrade: wanted("upgrade"),
    rollback: wanted("rollback"),
    reinstall: wanted("reinstall"),
  });
  st.plan = plan;
  await ctx.db.update(toolchainRuns).set({ plan }).where(eq(toolchainRuns.id, run.id));

  const planned = new Set(plan.steps.map((s) => s.tool));
  const errored = new Map(plan.errors.map((e) => [e.tool, e.reason]));
  for (const e of plan.errors) {
    st.failed++;
    st.errors.push(`${e.tool}: ${e.reason}`);
    await setTool(ctx, ws.id, e.tool, { state: "failed", lastError: e.reason });
  }
  // Managed tools the plan leaves alone are in sync; clear leftovers of an earlier failure.
  for (const r of rows) {
    if (planned.has(r.toolId as ToolId) || errored.has(r.toolId as ToolId)) continue;
    if (
      r.backend !== null &&
      r.installedVersion !== null &&
      r.state !== "idle" &&
      r.state !== "external"
    ) {
      await setTool(ctx, ws.id, r.toolId, { state: "idle", lastError: null });
    }
  }

  // 3. Apply.
  if (plan.steps.length > 0) {
    const priorState = new Map(rows.map((r) => [r.toolId, r.state]));
    for (const s of plan.steps) {
      await setTool(ctx, ws.id, s.tool, {
        state: s.action === "remove" ? "removing" : "installing",
        lastError: null,
      });
    }
    let outcome: AgentOutcome;
    try {
      outcome = await driveAgentRun(
        ctx,
        ws.slug,
        idBase,
        "apply",
        plan.steps.map((s) => toAgentStep(s, latest[s.tool])),
        progress(() => []),
      );
    } catch (e) {
      if (e instanceof AgentRefusedError) {
        for (const s of plan.steps) {
          await setTool(ctx, ws.id, s.tool, {
            state: "failed",
            lastError: e.message,
            requestedAction: null,
          });
        }
        st.failed += plan.steps.length;
        st.errors.push(e.message);
      }
      throw e;
    }
    if (outcome.kind === "interrupted") {
      for (const s of plan.steps) {
        await setTool(ctx, ws.id, s.tool, { state: priorState.get(s.tool) as ToolState });
      }
      return "interrupted";
    }
    await settleSteps(ctx, ws, run, st, plan.steps, outcome);
  }

  // One-shot requests are consumed: a step settled, or there was nothing to do / nothing possible.
  for (const r of rows) {
    if (r.requestedAction === null) continue;
    await ctx.db
      .update(workspaceTools)
      .set({ requestedAction: null, updatedAt: ctx.now() })
      .where(
        and(
          eq(workspaceTools.workspaceId, ws.id),
          eq(workspaceTools.toolId, r.toolId),
          eq(workspaceTools.requestedAction, r.requestedAction),
        ),
      );
  }
  return "settled";
}

/** Turn the agent's step records into tool rows. A failed step keeps what was installed before. */
async function settleSteps(
  ctx: Ctx,
  ws: WorkspaceRow,
  run: RunRow,
  st: RunState,
  steps: PlanStep[],
  outcome: Extract<AgentOutcome, { kind: "finished" | "timeout" }>,
): Promise<void> {
  const result = outcome.kind === "finished" ? outcome.result : null;
  const records = outcome.steps.filter((r) => r.action !== "verify");
  const now = ctx.now();
  const timedOut = outcome.kind === "timeout";

  for (const step of steps) {
    const rec = [...records].reverse().find((r) => r.tool === step.tool);
    const observed = result?.tools[step.tool];
    if (rec?.status === "ok") {
      st.ok++;
      if (step.action === "remove") {
        await setTool(ctx, ws.id, step.tool, {
          state: "idle",
          installedVersion: null,
          previousVersion: null,
          backend: null,
          installedAt: null,
          sizeBytes: null,
          observedAt: now,
          lastError: null,
        });
      } else {
        const installedAt = observed ? new Date(observed.installedAt) : now;
        await setTool(ctx, ws.id, step.tool, {
          state: "idle",
          installedVersion: rec.version ?? observed?.version ?? step.to,
          previousVersion: rec.previous ?? observed?.previous ?? null,
          backend: rec.backend ?? observed?.backend ?? null,
          installedAt: Number.isNaN(installedAt.getTime()) ? now : installedAt,
          sizeBytes: rec.sizeBytes ?? observed?.sizeBytes ?? null,
          observedAt: now,
          lastError: null,
        });
      }
    } else {
      const reason = timedOut
        ? "timed out"
        : rec?.status === "failed"
          ? [rec.errorCode, rec.error].filter(Boolean).join(": ") || "failed"
          : "the step did not complete";
      st.failed++;
      st.errors.push(`${step.tool}: ${reason}`);
      await setTool(ctx, ws.id, step.tool, { state: "failed", lastError: reason, observedAt: now });
    }
  }
  const timedOutMsg = timedOut
    ? `The toolchain run timed out after ${Math.round(toolchainTuning.runTimeoutMs / 60_000)} minutes.`
    : null;
  if (timedOutMsg) st.errors.push(timedOutMsg);
  st.steps = [...st.steps, ...records];
  await ctx.db
    .update(toolchainRuns)
    .set({ steps: st.steps, log: st.log })
    .where(eq(toolchainRuns.id, run.id));
}
