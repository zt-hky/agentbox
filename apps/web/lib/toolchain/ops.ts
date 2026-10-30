import { eq } from "drizzle-orm";
import {
  VERSION_RE,
  isLine,
  requireEntry,
  selectableLines,
  selectablePins,
  type CatalogEntry,
  type Channel,
  type LatestInfo,
  type RequestedAction,
  type ToolId,
} from "@agentbox/core/toolchain";
import { loadToolchainSettings, requestReconcile, type ToolChange } from "@agentbox/db/toolchain";
import { workspaceTools, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { Db, DbLike } from "../db-types";
import { UserError } from "../errors";
import { assertCanApplyToolchain, TOOLCHAIN_WORKSPACE_STATUSES } from "./gate";
import { loadLatestMap, loadToolsView, type ToolRowView } from "./view";

export interface ToolchainActor {
  userId: string;
  ip: string | null;
}

export interface ToolSelection {
  channel: Channel;
  pinnedVersion?: string | null;
}

export type ToolAuditAction =
  "install" | "remove" | "pin" | "upgrade" | "rollback" | "reinstall" | "retry";

/**
 * Check a channel/pin choice against the catalog and what the sources publish. Lines (`3.12`) are
 * accepted only for tools with `lines` and only when they appear in the selectable list, so a
 * stale patch (`3.12.1`) can never be requested; other tools accept exact versions from the list.
 * Returns the normalised `{channel, pinnedVersion}`.
 */
export function validateSelection(
  entry: CatalogEntry,
  selection: ToolSelection,
  info: LatestInfo | undefined,
): { channel: Channel; pinnedVersion: string | null } {
  const { channel } = selection;
  if (!entry.channels.includes(channel)) {
    throw new UserError(`${entry.label} does not support the ${channel} channel`);
  }
  if (channel !== "pin") return { channel, pinnedVersion: null };

  const pinned = selection.pinnedVersion;
  if (!pinned || !VERSION_RE.test(pinned)) throw new UserError("Choose a version to pin");
  const versions = info?.versions ?? [];
  if (versions.length === 0) {
    throw new UserError(
      `No published ${entry.label} versions are known yet. Check for updates first.`,
    );
  }
  if (entry.lines) {
    if (!isLine(pinned) || pinned.split(".").length !== 2) {
      throw new UserError(
        `Pin ${entry.label} to a version line such as ${selectableLines(entry, versions)[0]?.line ?? "3.12"}; the newest patch in the line is installed.`,
      );
    }
    if (!selectableLines(entry, versions).some((l) => l.line === pinned)) {
      throw new UserError(`${entry.label} ${pinned} is not one of the available version lines`);
    }
    return { channel, pinnedVersion: pinned };
  }
  if (!selectablePins(entry, versions).includes(pinned)) {
    throw new UserError(`${entry.label} ${pinned} is not one of the recent published versions`);
  }
  return { channel, pinnedVersion: pinned };
}

interface WorkspaceCtx {
  id: string;
  slug: string;
  status: string;
}

async function requireWorkspace(database: DbLike, userId: string): Promise<WorkspaceCtx> {
  const [ws] = await database
    .select({ id: workspaces.id, slug: workspaces.slug, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (!ws) throw new UserError("You do not have a workspace yet");
  if (!(TOOLCHAIN_WORKSPACE_STATUSES as readonly string[]).includes(ws.status)) {
    throw new UserError(`Tools cannot be changed while the workspace is ${ws.status}`);
  }
  return ws;
}

async function requireTool(
  database: DbLike,
  userId: string,
  toolId: ToolId,
): Promise<{ ws: WorkspaceCtx; row: ToolRowView; entry: CatalogEntry }> {
  const entry = requireEntry(toolId);
  const settings = await loadToolchainSettings(database);
  if (settings.disabled.includes(toolId)) {
    throw new UserError(`${entry.label} is switched off by an administrator`);
  }
  const ws = await requireWorkspace(database, userId);
  // Reuse the page's seeding so a tool row always exists before it is changed.
  const view = await loadToolsView(database, userId);
  const row = view?.tools.find((t) => t.toolId === toolId);
  if (!row) throw new UserError("Tool not found");
  return { ws, row, entry };
}

/** Make sure a `workspace_tools` row exists (a catalog tool that is not an admin default has none). */
async function ensureRow(database: DbLike, workspaceId: string, row: ToolRowView): Promise<void> {
  await database
    .insert(workspaceTools)
    .values({
      workspaceId,
      toolId: row.toolId,
      channel: row.channel,
      pinnedVersion: row.pinnedVersion,
      desired: false,
      source: "user",
      state: "idle",
    })
    .onConflictDoNothing();
}

async function enqueue(
  database: Db,
  actor: ToolchainActor,
  ws: WorkspaceCtx,
  changes: ToolChange[],
  audit: { action: ToolAuditAction; metadata: Record<string, unknown> },
): Promise<{ runId: string; newRun: boolean }> {
  await assertCanApplyToolchain(database, { userId: actor.userId, workspaceStatus: ws.status });
  const res = await requestReconcile(database, {
    workspaceId: ws.id,
    trigger: "user",
    changes,
  });
  await writeAudit(database, {
    actorId: actor.userId,
    action: `toolchain.${audit.action}`,
    targetType: "workspace",
    targetId: ws.id,
    metadata: { slug: ws.slug, runId: res.runId, ...audit.metadata },
    ip: actor.ip,
  });
  return res;
}

/** A package manager installs only on top of a language the workspace wants. */
function assertLanguageWanted(row: ToolRowView, entry: CatalogEntry): void {
  if (row.installBlockedReason && !row.desired) {
    const language = entry.requires ? requireEntry(entry.requires).label : "its language";
    throw new UserError(`${entry.label} needs ${language}. ${row.installBlockedReason}.`);
  }
}

/** Install a tool (or its managed copy when the image ships one), optionally choosing the channel. */
export async function installTool(
  database: Db,
  actor: ToolchainActor,
  input: { toolId: ToolId; selection?: ToolSelection },
) {
  const { ws, row, entry } = await requireTool(database, actor.userId, input.toolId);
  assertLanguageWanted(row, entry);
  if (row.managed && row.desired) throw new UserError(`${entry.label} is already installed`);
  const chosen = input.selection
    ? validateSelection(entry, input.selection, (await loadLatestMap(database)).get(entry.id))
    : { channel: row.channel, pinnedVersion: row.pinnedVersion };
  await ensureRow(database, ws.id, row);
  return enqueue(
    database,
    actor,
    ws,
    [
      {
        toolId: entry.id,
        desired: true,
        channel: chosen.channel,
        pinnedVersion: chosen.pinnedVersion,
      },
    ],
    { action: "install", metadata: { tool: entry.id, ...chosen } },
  );
}

export async function removeTool(database: Db, actor: ToolchainActor, input: { toolId: ToolId }) {
  const { ws, row, entry } = await requireTool(database, actor.userId, input.toolId);
  if (row.external && !row.managed) {
    throw new UserError(`${entry.label} comes with the workspace image and cannot be removed here`);
  }
  if (!row.managed || !row.desired) throw new UserError(`${entry.label} is not installed`);
  return enqueue(database, actor, ws, [{ toolId: entry.id, desired: false }], {
    action: "remove",
    metadata: { tool: entry.id, version: row.installedVersion },
  });
}

/** Change the channel, or pin a version line / exact version. The next run applies a pin change. */
export async function selectToolVersion(
  database: Db,
  actor: ToolchainActor,
  input: { toolId: ToolId; selection: ToolSelection },
) {
  const { ws, row, entry } = await requireTool(database, actor.userId, input.toolId);
  assertLanguageWanted(row, entry);
  const chosen = validateSelection(
    entry,
    input.selection,
    (await loadLatestMap(database)).get(entry.id),
  );
  if (chosen.channel === row.channel && chosen.pinnedVersion === row.pinnedVersion && row.desired) {
    throw new UserError(`${entry.label} already uses that setting`);
  }
  await ensureRow(database, ws.id, row);
  return enqueue(
    database,
    actor,
    ws,
    [
      {
        toolId: entry.id,
        desired: true,
        channel: chosen.channel,
        pinnedVersion: chosen.pinnedVersion,
      },
    ],
    {
      action: "pin",
      metadata: {
        tool: entry.id,
        from: { channel: row.channel, pinnedVersion: row.pinnedVersion },
        to: chosen,
      },
    },
  );
}

async function oneShot(
  database: Db,
  actor: ToolchainActor,
  toolId: ToolId,
  action: RequestedAction,
  check: (row: ToolRowView, entry: CatalogEntry) => void,
) {
  const { ws, row, entry } = await requireTool(database, actor.userId, toolId);
  check(row, entry);
  return enqueue(database, actor, ws, [{ toolId, action }], {
    action,
    metadata: { tool: toolId, from: row.installedVersion, to: row.target },
  });
}

export const upgradeTool = (database: Db, actor: ToolchainActor, input: { toolId: ToolId }) =>
  oneShot(database, actor, input.toolId, "upgrade", (row, entry) => {
    if (!row.managed) throw new UserError(`${entry.label} is not installed`);
    if (!row.updateAvailable) throw new UserError(`${entry.label} is up to date`);
  });

export const rollbackTool = (database: Db, actor: ToolchainActor, input: { toolId: ToolId }) =>
  oneShot(database, actor, input.toolId, "rollback", (row, entry) => {
    if (!row.managed || !row.previousVersion) {
      throw new UserError(`${entry.label} has no previous version to roll back to`);
    }
  });

export const reinstallTool = (database: Db, actor: ToolchainActor, input: { toolId: ToolId }) =>
  oneShot(database, actor, input.toolId, "reinstall", (row, entry) => {
    if (!row.managed || !row.desired) throw new UserError(`${entry.label} is not installed`);
  });

/** Upgrade every managed tool that has a newer version on its channel. */
export async function upgradeAll(database: Db, actor: ToolchainActor) {
  const ws = await requireWorkspace(database, actor.userId);
  const view = await loadToolsView(database, actor.userId);
  const due = view?.tools.filter((t) => t.canUpgrade) ?? [];
  if (due.length === 0) throw new UserError("Every installed tool is up to date");
  return enqueue(
    database,
    actor,
    ws,
    due.map((t) => ({ toolId: t.toolId, action: "upgrade" as const })),
    {
      action: "upgrade",
      metadata: { all: true, tools: due.map((t) => ({ tool: t.toolId, to: t.updateAvailable })) },
    },
  );
}

/** Ask for another run after a failure: failed installs retry, failed upgrades are requested again. */
export async function retryFailed(database: Db, actor: ToolchainActor) {
  const ws = await requireWorkspace(database, actor.userId);
  const view = await loadToolsView(database, actor.userId);
  if (!view) throw new UserError("You do not have a workspace yet");
  const failedTools = view.tools.filter((t) => t.state === "failed" && t.desired);
  const runFailed = !!view.run && ["failed", "partial", "interrupted"].includes(view.run.status);
  if (failedTools.length === 0 && !runFailed) throw new UserError("Nothing failed in the last run");
  const changes: ToolChange[] = failedTools
    .filter((t) => t.canUpgrade)
    .map((t) => ({ toolId: t.toolId, action: "upgrade" as const }));
  return enqueue(database, actor, ws, changes, {
    action: "retry",
    metadata: { tools: failedTools.map((t) => t.toolId) },
  });
}
