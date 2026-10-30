import { desc, eq } from "drizzle-orm";
import {
  CATALOG,
  catalogEntry,
  isManaged,
  planSchema,
  resolveTarget,
  selectableLines,
  selectablePins,
  stepRecordSchema,
  updateAvailable,
  type CatalogEntry,
  type Channel,
  type LatestInfo,
  type ObservedRow,
  type Plan,
  type StepRecord,
  type ToolDefault,
  type ToolId,
  type ToolState,
} from "@agentbox/core/toolchain";
import { bakedToolsFor, loadToolchainSettings, seedWorkspaceTools } from "@agentbox/db/toolchain";
import { toolLatest, toolchainRuns, workspaceTools, workspaces } from "@agentbox/db/schema";
import { z } from "zod";
import type { DbLike } from "../db-types";

export const OPEN_RUN_STATUSES = ["queued", "waiting", "running"] as const;
export const HISTORY_LIMIT = 10;
const LOG_TAIL_LINES = 200;
const LOG_TAIL_CHARS = 16_000;

export interface ToolRowView {
  toolId: ToolId;
  label: string;
  description: string;
  kind: CatalogEntry["kind"];
  channel: Channel;
  pinnedVersion: string | null;
  /** The user wants this tool installed. */
  desired: boolean;
  /** A managed copy exists in the workspace. */
  managed: boolean;
  /** The image ships the tool; no managed copy yet. */
  external: boolean;
  installedVersion: string | null;
  previousVersion: string | null;
  sizeBytes: number | null;
  sizeHintMb: number;
  /** State to show: `idle` with a wanted-but-missing (or unwanted-but-present) tool reads as pending. */
  state: ToolState;
  lastError: string | null;
  /** Exact version the channel resolves to now. */
  target: string | null;
  targetReason: string | null;
  updateAvailable: string | null;
  channels: Channel[];
  lines: { line: string; latest: string }[];
  pins: string[];
  canInstall: boolean;
  canUpgrade: boolean;
  canRemove: boolean;
  canRollback: boolean;
  canReinstall: boolean;
  t3Driver: string | null;
}

export interface RunView {
  id: string;
  status: string;
  trigger: string;
  open: boolean;
  generation: number;
  plan: Plan | null;
  steps: StepRecord[];
  progress: { done: number; total: number };
  error: string | null;
  logTail: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolsView {
  workspace: {
    id: string;
    slug: string;
    status: string;
    generation: number;
    appliedGeneration: number;
    pending: boolean;
  };
  tools: ToolRowView[];
  /** Open run, else the most recent one. */
  run: RunView | null;
  history: RunView[];
  latestCheckedAt: string | null;
  /** Tool ids whose last version check failed. */
  latestErrors: { toolId: ToolId; error: string }[];
}

export function toLatestInfo(row: typeof toolLatest.$inferSelect): LatestInfo {
  return { latest: row.latest, lts: row.lts, versions: row.versions, meta: row.meta };
}

export async function loadLatestMap(database: DbLike): Promise<Map<ToolId, LatestInfo>> {
  const rows = await database.select().from(toolLatest);
  const out = new Map<ToolId, LatestInfo>();
  for (const r of rows) if (catalogEntry(r.toolId)) out.set(r.toolId as ToolId, toLatestInfo(r));
  return out;
}

export function tailLog(log: string | null): string {
  if (!log) return "";
  const lines = log.split("\n");
  let out = lines.slice(-LOG_TAIL_LINES).join("\n");
  if (out.length > LOG_TAIL_CHARS) out = out.slice(-LOG_TAIL_CHARS);
  return out;
}

const stepsSchema = z.array(stepRecordSchema);

export function toRunView(r: typeof toolchainRuns.$inferSelect, withLog: boolean): RunView {
  const plan = planSchema.safeParse(r.plan);
  const steps = stepsSchema.safeParse(r.steps);
  const stepList = steps.success ? steps.data : [];
  const planned = plan.success ? plan.data.steps.length : 0;
  const settled = stepList.filter((s) => s.status !== "running").length;
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    open: (OPEN_RUN_STATUSES as readonly string[]).includes(r.status),
    generation: r.generation,
    plan: plan.success ? plan.data : null,
    steps: stepList,
    progress: { done: settled, total: Math.max(planned, settled) },
    error: r.error,
    logTail: withLog ? tailLog(r.log) : "",
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** Admin defaults for the tools a workspace has no row for yet. */
function defaultFor(defaults: readonly ToolDefault[], entry: CatalogEntry) {
  const d = defaults.find((x) => x.tool === entry.id);
  return {
    channel: d?.channel ?? entry.channels[0] ?? "latest",
    pinnedVersion: d?.channel === "pin" ? (d.pinnedVersion ?? null) : null,
  };
}

export function buildToolRow(
  entry: CatalogEntry,
  row: typeof workspaceTools.$inferSelect | undefined,
  info: LatestInfo | undefined,
  fallback: { channel: Channel; pinnedVersion: string | null },
): ToolRowView {
  const channel = row?.channel ?? fallback.channel;
  const pinnedVersion = row ? row.pinnedVersion : fallback.pinnedVersion;
  const desired = row?.desired ?? false;
  const observed: ObservedRow | undefined = row
    ? {
        toolId: entry.id,
        state: row.state,
        installedVersion: row.installedVersion,
        previousVersion: row.previousVersion,
        backend: row.backend,
      }
    : undefined;
  const managed = isManaged(observed);
  const external = row?.state === "external";
  const target = resolveTarget(entry, channel, pinnedVersion, info);
  const update = updateAvailable(entry, { channel, pinnedVersion }, observed, info);
  const rawState: ToolState = row?.state ?? "idle";
  const waiting = rawState === "idle" && ((desired && !managed) || (!desired && managed && !!row));
  const state: ToolState = waiting ? "pending" : rawState;
  const inFlight = desired && (rawState === "pending" || rawState === "installing");
  const versions = info?.versions ?? [];
  return {
    toolId: entry.id,
    label: entry.label,
    description: entry.description,
    kind: entry.kind,
    channel,
    pinnedVersion,
    desired,
    managed,
    external,
    installedVersion: row?.installedVersion ?? null,
    previousVersion: row?.previousVersion ?? null,
    sizeBytes: row?.sizeBytes ?? null,
    sizeHintMb: entry.sizeHintMb,
    state,
    lastError: row?.lastError ?? null,
    target: target.ok ? target.version : null,
    targetReason: target.ok ? null : target.reason,
    updateAvailable: update,
    channels: entry.channels,
    lines: selectableLines(entry, versions),
    pins: selectablePins(entry, versions),
    canInstall: !managed && !inFlight,
    canUpgrade: managed && update !== null,
    canRemove: managed && desired,
    canRollback: managed && !!row?.previousVersion,
    canReinstall: managed && desired,
    t3Driver: entry.t3Driver,
  };
}

/**
 * Create the tool rows an admin default calls for and the workspace lacks (existing rows are never
 * touched), then return all rows.
 */
export async function seedMissingTools(
  database: DbLike,
  ws: Pick<typeof workspaces.$inferSelect, "id" | "imageId" | "pinnedImageId">,
  defaults: readonly ToolDefault[],
): Promise<(typeof workspaceTools.$inferSelect)[]> {
  let rows = await database
    .select()
    .from(workspaceTools)
    .where(eq(workspaceTools.workspaceId, ws.id));
  const have = new Set(rows.map((r) => r.toolId));
  const missing = defaults.filter((d) => !have.has(d.tool));
  if (missing.length > 0) {
    await seedWorkspaceTools(database, ws.id, {
      defaults: missing,
      baked: await bakedToolsFor(database, ws),
    });
    rows = await database
      .select()
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
  }
  return rows;
}

/**
 * Everything the Tools page shows for a user's workspace; null when the user has none. Missing
 * tool rows are seeded from the admin defaults on the way (existing rows are never touched).
 */
export async function loadToolsView(database: DbLike, userId: string): Promise<ToolsView | null> {
  const [ws] = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (!ws || ws.status === "deleted" || ws.status === "deleting") return null;

  const settings = await loadToolchainSettings(database);
  const rows = await seedMissingTools(database, ws, settings.defaults);

  const [latestRows, runRows] = await Promise.all([
    database.select().from(toolLatest),
    database
      .select()
      .from(toolchainRuns)
      .where(eq(toolchainRuns.workspaceId, ws.id))
      .orderBy(desc(toolchainRuns.createdAt))
      .limit(HISTORY_LIMIT),
  ]);
  const latest = new Map<string, LatestInfo>(latestRows.map((r) => [r.toolId, toLatestInfo(r)]));
  const byTool = new Map(rows.map((r) => [r.toolId, r]));
  const disabled = new Set<string>(settings.disabled);

  const tools = CATALOG.filter((e) => !disabled.has(e.id)).map((e) =>
    buildToolRow(e, byTool.get(e.id), latest.get(e.id), defaultFor(settings.defaults, e)),
  );
  const current =
    runRows.find((r) => (OPEN_RUN_STATUSES as readonly string[]).includes(r.status)) ?? runRows[0];
  const checked = latestRows
    .map((r) => r.checkedAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    workspace: {
      id: ws.id,
      slug: ws.slug,
      status: ws.status,
      generation: ws.toolchainGeneration,
      appliedGeneration: ws.toolchainAppliedGeneration,
      pending: ws.toolchainPending,
    },
    tools,
    run: current ? toRunView(current, true) : null,
    history: runRows.map((r) => toRunView(r, false)),
    latestCheckedAt: checked?.toISOString() ?? null,
    latestErrors: latestRows
      .filter((r) => r.error && catalogEntry(r.toolId) && !disabled.has(r.toolId))
      .map((r) => ({ toolId: r.toolId as ToolId, error: r.error as string })),
  };
}

/** The part of the page that changes while a run is in flight (polled every 2 s). */
export async function loadRunPanel(
  database: DbLike,
  userId: string,
): Promise<{ run: RunView | null; history: RunView[]; status: string } | null> {
  const [ws] = await database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (!ws) return null;
  const runRows = await database
    .select()
    .from(toolchainRuns)
    .where(eq(toolchainRuns.workspaceId, ws.id))
    .orderBy(desc(toolchainRuns.createdAt))
    .limit(HISTORY_LIMIT);
  const current =
    runRows.find((r) => (OPEN_RUN_STATUSES as readonly string[]).includes(r.status)) ?? runRows[0];
  return {
    run: current ? toRunView(current, true) : null,
    history: runRows.map((r) => toRunView(r, false)),
    status: ws.status,
  };
}
