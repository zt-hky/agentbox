import { desc, eq } from "drizzle-orm";
import { CATALOG, type ToolId, type ToolKind } from "@agentbox/core/toolchain";
import { loadToolchainSettings } from "@agentbox/db/toolchain";
import { toolchainRuns, workspaceTools, workspaces } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";
import { progressToolState, type ProgressToolState } from "./onboarding";
import {
  OPEN_RUN_STATUSES,
  buildToolRow,
  defaultFor,
  loadLatestMap,
  toRunView,
} from "./toolchain/view";

export interface DashboardTool {
  toolId: ToolId;
  label: string;
  kind: ToolKind;
  state: ProgressToolState;
  installedVersion: string | null;
  updateAvailable: string | null;
  desired: boolean;
  sizeBytes: number | null;
  lastError: string | null;
}

export interface DashboardToolSummary {
  workspaceStatus: string;
  tools: DashboardTool[];
  counts: { installed: number; pending: number; failed: number; updates: number };
  run: { open: boolean; done: number; total: number } | null;
}

/** Installed and wanted tools of the user's live workspace; null when there is none. Read-only. */
export async function loadDashboardToolSummary(
  database: DbLike,
  userId: string,
): Promise<DashboardToolSummary | null> {
  const [ws] = await database.select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1);
  if (!ws || ws.status === "deleted" || ws.status === "deleting") return null;

  const [rows, latest, settings, runRows] = await Promise.all([
    database.select().from(workspaceTools).where(eq(workspaceTools.workspaceId, ws.id)),
    loadLatestMap(database),
    loadToolchainSettings(database),
    database
      .select()
      .from(toolchainRuns)
      .where(eq(toolchainRuns.workspaceId, ws.id))
      .orderBy(desc(toolchainRuns.createdAt))
      .limit(5),
  ]);
  const byTool = new Map(rows.map((r) => [r.toolId, r]));
  const disabled = new Set<string>(settings.disabled);

  const tools: DashboardTool[] = [];
  for (const entry of CATALOG) {
    const row = byTool.get(entry.id);
    if (!row || disabled.has(entry.id)) continue;
    const view = buildToolRow(entry, row, latest.get(entry.id), defaultFor(settings.defaults, entry));
    if (!view.desired && !view.managed) continue;
    tools.push({
      toolId: entry.id,
      label: entry.label,
      kind: entry.kind,
      state: progressToolState({
        state: row.state,
        desired: row.desired,
        installedVersion: row.installedVersion,
        backend: row.backend,
      }),
      installedVersion: view.installedVersion,
      updateAvailable: view.updateAvailable,
      desired: view.desired,
      sizeBytes: view.sizeBytes,
      lastError: view.lastError,
    });
  }

  const open = runRows.find((r) => (OPEN_RUN_STATUSES as readonly string[]).includes(r.status));
  const current = open ?? null;
  const view = current ? toRunView(current, false) : null;
  return {
    workspaceStatus: ws.status,
    tools,
    counts: {
      installed: tools.filter((t) => t.state === "installed" || t.state === "external").length,
      pending: tools.filter((t) => t.state === "pending" || t.state === "installing" || t.state === "removing").length,
      failed: tools.filter((t) => t.state === "failed").length,
      updates: tools.filter((t) => t.updateAvailable !== null).length,
    },
    run: view ? { open: true, done: view.progress.done, total: view.progress.total } : null,
  };
}
