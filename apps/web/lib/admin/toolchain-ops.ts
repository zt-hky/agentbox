import { desc, eq, inArray } from "drizzle-orm";
import {
  CATALOG,
  catalogEntry,
  selectableLines,
  selectablePins,
  toolchainDefaultsSchema,
  type Channel,
  type LatestInfo,
  type ToolDefault,
  type ToolId,
  type ToolState,
} from "@agentbox/core/toolchain";
import {
  loadToolchainSettings,
  requestReconcile,
  type ToolchainSettingsValue,
} from "@agentbox/db/toolchain";
import { toolLatest, toolchainRuns, user, workspaceTools, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { Db, DbLike } from "../db-types";
import { UserError } from "../errors";
import { assertCanApplyToolchain } from "../toolchain/gate";
import { validateSelection } from "../toolchain/ops";
import { buildToolRow, seedMissingTools, toLatestInfo } from "../toolchain/view";

export interface AdminActor {
  adminId: string;
  ip: string | null;
}

/** Workspaces a reconcile can target, and the subset that is awake. */
const LIVE_STATUSES = ["sleeping", "starting", "running", "stopping", "error"] as const;
const RUNNING_ONLY_STATUSES = ["running", "starting"] as const;

export interface FleetCell {
  installed: string | null;
  state: ToolState;
  outdated: boolean;
}

export interface FleetRow {
  slug: string;
  owner: string | null;
  status: string;
  pending: boolean;
  generation: number;
  appliedGeneration: number;
  reconciledAt: string | null;
  cells: Partial<Record<ToolId, FleetCell>>;
  outdated: number;
  failed: number;
  lastRun: { status: string; at: string; error: string | null } | null;
}

export interface CatalogAdminRow {
  toolId: ToolId;
  label: string;
  kind: "runtime" | "agent";
  channels: Channel[];
  disabled: boolean;
  /** Default install channel, null when the tool is not installed by default. */
  defaultChannel: Channel | null;
  defaultPin: string | null;
  /** Version choices for the pin selector; empty until a check ran. */
  suggestions: string[];
  lines: boolean;
}

export interface LatestStatusRow {
  toolId: ToolId;
  label: string;
  latest: string | null;
  lts: string | null;
  versionCount: number;
  checkedAt: string | null;
  error: string | null;
}

export interface AdminToolchainView {
  catalog: CatalogAdminRow[];
  latest: LatestStatusRow[];
  fleet: FleetRow[];
  /** Workspaces a bulk reconcile reaches (sleeping ones are started), and how many are awake. */
  liveCount: number;
  runningCount: number;
}

const MAX_FLEET = 500;

export async function loadAdminToolchain(database: DbLike): Promise<AdminToolchainView> {
  const settings = await loadToolchainSettings(database);
  const latestRows = await database.select().from(toolLatest);
  const info = new Map<string, LatestInfo>(latestRows.map((r) => [r.toolId, toLatestInfo(r)]));

  const catalog = CATALOG.map<CatalogAdminRow>((e) => {
    const d = settings.defaults.find((x) => x.tool === e.id);
    const versions = info.get(e.id)?.versions ?? [];
    return {
      toolId: e.id,
      label: e.label,
      kind: e.kind,
      channels: e.channels,
      disabled: settings.disabled.includes(e.id),
      defaultChannel: d?.channel ?? null,
      defaultPin: d?.channel === "pin" ? (d.pinnedVersion ?? null) : null,
      suggestions: e.lines
        ? selectableLines(e, versions).map((l) => l.line)
        : selectablePins(e, versions),
      lines: e.lines,
    };
  });

  const latest = CATALOG.map<LatestStatusRow>((e) => {
    const r = latestRows.find((x) => x.toolId === e.id);
    return {
      toolId: e.id,
      label: e.label,
      latest: r?.latest ?? null,
      lts: r?.lts ?? null,
      versionCount: r?.versions.length ?? 0,
      checkedAt: r?.checkedAt?.toISOString() ?? null,
      error: r?.error ?? null,
    };
  });

  const wsRows = await database
    .select({ ws: workspaces, email: user.email })
    .from(workspaces)
    .leftJoin(user, eq(user.id, workspaces.userId))
    .where(inArray(workspaces.status, [...LIVE_STATUSES, "provisioning"]))
    .orderBy(workspaces.slug)
    .limit(MAX_FLEET);
  const ids = wsRows.map((r) => r.ws.id);
  const toolRows = ids.length
    ? await database.select().from(workspaceTools).where(inArray(workspaceTools.workspaceId, ids))
    : [];
  const runRows = ids.length
    ? await database
        .select()
        .from(toolchainRuns)
        .where(inArray(toolchainRuns.workspaceId, ids))
        .orderBy(desc(toolchainRuns.createdAt))
    : [];
  const lastRun = new Map<string, (typeof runRows)[number]>();
  for (const r of runRows) if (!lastRun.has(r.workspaceId)) lastRun.set(r.workspaceId, r);

  const disabled = new Set<string>(settings.disabled);
  const fleet = wsRows.map<FleetRow>(({ ws, email }) => {
    const cells: FleetRow["cells"] = {};
    let outdated = 0;
    let failed = 0;
    for (const row of toolRows.filter((t) => t.workspaceId === ws.id)) {
      const entry = catalogEntry(row.toolId);
      if (!entry || disabled.has(entry.id)) continue;
      const view = buildToolRow(entry, row, info.get(entry.id), {
        channel: row.channel,
        pinnedVersion: row.pinnedVersion,
      });
      cells[entry.id] = {
        installed: view.installedVersion,
        state: view.state,
        outdated: view.updateAvailable !== null,
      };
      if (view.updateAvailable) outdated++;
      if (view.state === "failed") failed++;
    }
    const run = lastRun.get(ws.id);
    return {
      slug: ws.slug,
      owner: email,
      status: ws.status,
      pending: ws.toolchainPending,
      generation: ws.toolchainGeneration,
      appliedGeneration: ws.toolchainAppliedGeneration,
      reconciledAt: ws.toolchainReconciledAt?.toISOString() ?? null,
      cells,
      outdated,
      failed,
      lastRun: run
        ? { status: run.status, at: run.createdAt.toISOString(), error: run.error }
        : null,
    };
  });

  return {
    catalog,
    latest,
    fleet,
    liveCount: fleet.filter((f) => (LIVE_STATUSES as readonly string[]).includes(f.status)).length,
    runningCount: fleet.filter((f) =>
      (RUNNING_ONLY_STATUSES as readonly string[]).includes(f.status),
    ).length,
  };
}

/**
 * Check an admin `toolchain` setting before it is saved: every default must use a channel the
 * tool offers, and pins follow the same rules as a user's pin (lines for node/python, exact
 * versions from the published list for the rest). Throws UserError.
 */
export function validateToolchainSettings(
  value: ToolchainSettingsValue,
  latest: ReadonlyMap<string, LatestInfo>,
): void {
  const parsed = toolchainDefaultsSchema.safeParse(value.defaults);
  if (!parsed.success) throw new UserError("Invalid tool defaults");
  const seen = new Set<ToolId>();
  for (const d of value.defaults as ToolDefault[]) {
    if (seen.has(d.tool))
      throw new UserError(`${catalogEntry(d.tool)?.label ?? d.tool} is listed twice`);
    seen.add(d.tool);
    const entry = catalogEntry(d.tool);
    if (!entry) throw new UserError(`Unknown tool ${d.tool}`);
    validateSelection(
      entry,
      { channel: d.channel, pinnedVersion: d.pinnedVersion },
      latest.get(d.tool),
    );
  }
}

export async function loadLatestForValidation(database: DbLike): Promise<Map<string, LatestInfo>> {
  const rows = await database.select().from(toolLatest);
  return new Map(rows.map((r) => [r.toolId, toLatestInfo(r)]));
}

async function findWorkspace(database: DbLike, slug: string) {
  const [row] = await database
    .select({ ws: workspaces })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  if (!row) throw new UserError("Workspace not found");
  return row.ws;
}

/** Reconcile one workspace now (starts it when asleep, like any other apply). */
export async function reconcileWorkspace(database: Db, actor: AdminActor, slug: string) {
  const ws = await findWorkspace(database, slug);
  if (!(LIVE_STATUSES as readonly string[]).includes(ws.status)) {
    throw new UserError(`Cannot reconcile a workspace that is ${ws.status}`);
  }
  await assertCanApplyToolchain(database, { userId: ws.userId, workspaceStatus: ws.status });
  const settings = await loadToolchainSettings(database);
  await seedMissingTools(database, ws, settings.defaults);
  const res = await requestReconcile(database, {
    workspaceId: ws.id,
    trigger: "admin",
  });
  await writeAudit(database, {
    actorId: actor.adminId,
    action: "toolchain.reconcile",
    targetType: "workspace",
    targetId: ws.id,
    metadata: { slug: ws.slug, runId: res.runId, newRun: res.newRun },
    ip: actor.ip,
  });
  return res;
}

export interface BulkResult {
  /** Runs queued or joined. */
  requested: number;
  /** Of those, a run already covered the request. */
  coalesced: number;
  skippedNotRunning: number;
  /** Owners whose plan or account cannot start the workspace. */
  skippedBlocked: number;
}

/**
 * Reconcile every live workspace (`trigger: bulk`). Sleeping ones are started by the worker unless
 * `runningOnly` is set, in which case they are skipped and counted.
 */
export async function reconcileAll(
  database: Db,
  actor: AdminActor,
  opts: { runningOnly: boolean },
): Promise<BulkResult> {
  const rows = await database
    .select()
    .from(workspaces)
    .where(inArray(workspaces.status, [...LIVE_STATUSES]))
    .orderBy(workspaces.slug);
  const settings = await loadToolchainSettings(database);
  const result: BulkResult = {
    requested: 0,
    coalesced: 0,
    skippedNotRunning: 0,
    skippedBlocked: 0,
  };
  for (const ws of rows) {
    if (opts.runningOnly && !(RUNNING_ONLY_STATUSES as readonly string[]).includes(ws.status)) {
      result.skippedNotRunning++;
      continue;
    }
    try {
      await assertCanApplyToolchain(database, { userId: ws.userId, workspaceStatus: ws.status });
    } catch (e) {
      if (e instanceof UserError) {
        result.skippedBlocked++;
        continue;
      }
      throw e;
    }
    await seedMissingTools(database, ws, settings.defaults);
    const res = await requestReconcile(database, { workspaceId: ws.id, trigger: "bulk" });
    result.requested++;
    if (!res.newRun) result.coalesced++;
  }
  await writeAudit(database, {
    actorId: actor.adminId,
    action: "toolchain.reconcile_all",
    targetType: "toolchain",
    targetId: null,
    metadata: { runningOnly: opts.runningOnly, ...result },
    ip: actor.ip,
  });
  return result;
}
