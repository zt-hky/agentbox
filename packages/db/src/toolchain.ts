import { and, desc, eq, inArray } from "drizzle-orm";
import {
  BAKED_TOOL_IDS,
  DEFAULT_TOOL_DEFAULTS,
  catalogEntry,
  parseImageManifest,
  type Channel,
  type RequestedAction,
  type ToolDefault,
  type ToolId,
} from "@agentbox/core/toolchain";
import { readSetting, type Db } from "./client.ts";
import { images, jobs, toolchainRuns, workspaceTools, workspaces } from "./schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
type DbLike = Db | Tx;

export interface ToolchainSettingsValue {
  defaults: ToolDefault[];
  disabled: ToolId[];
}

/** Admin `toolchain` setting, falling back to the built-in defaults. */
export async function loadToolchainSettings(database: DbLike): Promise<ToolchainSettingsValue> {
  const s = await readSetting(database, "toolchain");
  return {
    defaults: s ? (s.defaults as ToolDefault[]) : [...DEFAULT_TOOL_DEFAULTS],
    disabled: s?.disabled ?? [],
  };
}

/**
 * Catalog tools the image a workspace runs (or will run) bakes in. Images built before manifests
 * existed shipped node, claude, codex and omp.
 */
export async function bakedToolsFor(
  database: DbLike,
  ws: { imageId: string | null; pinnedImageId: string | null },
): Promise<ToolId[]> {
  let row: { manifest: unknown } | undefined;
  if (ws.imageId) {
    [row] = await database
      .select({ manifest: images.manifest })
      .from(images)
      .where(eq(images.imageId, ws.imageId))
      .limit(1);
  } else if (ws.pinnedImageId) {
    [row] = await database
      .select({ manifest: images.manifest })
      .from(images)
      .where(eq(images.id, ws.pinnedImageId))
      .limit(1);
  } else {
    [row] = await database
      .select({ manifest: images.manifest })
      .from(images)
      .where(eq(images.status, "active"))
      .limit(1);
  }
  if (!row) return [...BAKED_TOOL_IDS];
  return parseImageManifest(row.manifest)?.baked ?? (row.manifest == null ? [...BAKED_TOOL_IDS] : []);
}

/**
 * Create the workspace's tool rows from the admin defaults. Existing rows (the user's choices) are
 * never touched. A default tool the image already ships starts as `external`: it works today, and a
 * managed copy replaces it on the next reconcile.
 */
export async function seedWorkspaceTools(
  database: DbLike,
  workspaceId: string,
  opts: { defaults: readonly ToolDefault[]; baked: readonly ToolId[] },
): Promise<void> {
  if (opts.defaults.length === 0) return;
  await database
    .insert(workspaceTools)
    .values(
      opts.defaults.map((d) => ({
        workspaceId,
        toolId: d.tool,
        channel: d.channel,
        pinnedVersion: d.channel === "pin" ? (d.pinnedVersion ?? null) : null,
        desired: true,
        source: "default" as const,
        state: opts.baked.includes(d.tool) ? ("external" as const) : ("pending" as const),
      })),
    )
    .onConflictDoNothing();
}

export interface ToolChange {
  toolId: ToolId;
  channel?: Channel;
  pinnedVersion?: string | null;
  desired?: boolean;
  /** One-shot request for the next plan (upgrade to the channel target, roll back, reinstall). */
  action?: RequestedAction | null;
}

export interface RequestReconcileInput {
  workspaceId: string;
  trigger: "user" | "admin" | "start" | "defaults" | "bulk";
  changes?: readonly ToolChange[];
}

export interface RequestReconcileResult {
  runId: string;
  /** False when a queued or running run already covered the request. */
  newRun: boolean;
}

const OPEN_RUN_STATUSES = ["queued", "waiting", "running"] as const;

/**
 * Record a desired-state change and make sure a `reconcile_toolchain` job will apply it.
 * Bumps the workspace's toolchain generation; the partial unique index on jobs coalesces repeated
 * requests, and the worker drains again when the generation moved during a run.
 */
export async function requestReconcile(
  database: Db,
  input: RequestReconcileInput,
): Promise<RequestReconcileResult> {
  return database.transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id, generation: workspaces.toolchainGeneration })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for("update");
    if (!ws) throw new Error(`workspace ${input.workspaceId} not found`);
    const generation = ws.generation + 1;
    await tx
      .update(workspaces)
      .set({ toolchainGeneration: generation })
      .where(eq(workspaces.id, ws.id));

    for (const c of input.changes ?? []) {
      if (!catalogEntry(c.toolId)) throw new Error(`unknown tool ${c.toolId}`);
      const set: Partial<typeof workspaceTools.$inferInsert> = {
        source: input.trigger === "defaults" ? "default" : "user",
        updatedAt: new Date(),
      };
      if (c.channel !== undefined) set.channel = c.channel;
      if (c.pinnedVersion !== undefined) set.pinnedVersion = c.pinnedVersion;
      if (c.desired !== undefined) set.desired = c.desired;
      if (c.action !== undefined) set.requestedAction = c.action;
      await tx
        .update(workspaceTools)
        .set(set)
        .where(and(eq(workspaceTools.workspaceId, ws.id), eq(workspaceTools.toolId, c.toolId)));
    }

    const [open] = await tx
      .select({ id: toolchainRuns.id })
      .from(toolchainRuns)
      .where(
        and(
          eq(toolchainRuns.workspaceId, ws.id),
          inArray(toolchainRuns.status, [...OPEN_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(toolchainRuns.createdAt))
      .limit(1);
    let runId = open?.id;
    if (runId) {
      await tx.update(toolchainRuns).set({ generation }).where(eq(toolchainRuns.id, runId));
    } else {
      const [created] = await tx
        .insert(toolchainRuns)
        .values({ workspaceId: ws.id, trigger: input.trigger, status: "queued", generation })
        .returning({ id: toolchainRuns.id });
      if (!created) throw new Error("could not create toolchain run");
      runId = created.id;
    }
    await tx
      .insert(jobs)
      .values({ type: "reconcile_toolchain", workspaceId: ws.id, payload: {} })
      .onConflictDoNothing();
    return { runId, newRun: !open };
  });
}
