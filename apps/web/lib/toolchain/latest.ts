import { CATALOG, fetchLatestInfo, type FetchLike, type ToolId } from "@agentbox/core/toolchain";
import { loadToolchainSettings, upsertToolLatest } from "@agentbox/db/toolchain";
import { toolLatest } from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { Db } from "../db-types";

const FETCH_TIMEOUT_MS = 15_000;
/** A user-triggered check skips tools that were checked this recently. */
export const USER_REFRESH_MIN_AGE_MS = 60_000;

export const httpFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export interface RefreshResult {
  refreshed: ToolId[];
  skipped: ToolId[];
  failed: { toolId: ToolId; error: string }[];
}

/**
 * Refresh `tool_latest` for every enabled catalog tool. A failed source keeps the previous data
 * and records the error. `force` ignores the recent-check throttle (admin "Refresh now").
 */
export async function refreshToolLatest(
  database: Db,
  opts: { actorId: string; ip: string | null; force: boolean; fetchImpl?: FetchLike; now?: Date },
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? httpFetch;
  const [settings, existing] = await Promise.all([
    loadToolchainSettings(database),
    database
      .select({ toolId: toolLatest.toolId, checkedAt: toolLatest.checkedAt })
      .from(toolLatest),
  ]);
  const checked = new Map(existing.map((r) => [r.toolId, r.checkedAt]));
  const result: RefreshResult = { refreshed: [], skipped: [], failed: [] };

  const entries = CATALOG.filter((e) => !settings.disabled.includes(e.id));
  await Promise.all(
    entries.map(async (entry) => {
      const at = checked.get(entry.id);
      if (!opts.force && at && now.getTime() - at.getTime() < USER_REFRESH_MIN_AGE_MS) {
        result.skipped.push(entry.id);
        return;
      }
      try {
        const info = await fetchLatestInfo(entry, fetchImpl);
        await upsertToolLatest(database, entry.id, { info }, now);
        result.refreshed.push(entry.id);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await upsertToolLatest(database, entry.id, { error }, now);
        result.failed.push({ toolId: entry.id, error });
      }
    }),
  );
  await writeAudit(database, {
    actorId: opts.actorId,
    action: "toolchain.refresh",
    targetType: "toolchain",
    targetId: null,
    metadata: {
      force: opts.force,
      refreshed: result.refreshed.length,
      failed: result.failed.map((f) => f.toolId),
    },
    ip: opts.ip,
  });
  return result;
}
