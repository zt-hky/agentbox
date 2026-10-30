import { eq } from "drizzle-orm";
import {
  TOOL_LATEST_TTL_MS,
  fetchRegistryVersions,
  registryVersionSource,
  type FetchLike,
  type ToolId,
} from "@agentbox/core/toolchain";
import { toolLatest } from "@agentbox/db/schema";
import { upsertToolLatest } from "@agentbox/db/toolchain";
import type { Db } from "../db-types";
import { httpFetch } from "./latest";

/** After a failed fetch the same tool is not retried for this long (this server process). */
export const REGISTRY_VERSIONS_NEGATIVE_TTL_MS = 60_000;
const failedAt = new Map<string, number>();

/**
 * Published versions of a registry tool (`mise:<name>`), newest first, stable only, at most 50.
 * Served from `tool_latest` while it is younger than the worker's hourly cadence, otherwise
 * fetched from the tool's source and stored. These tools are not part of the hourly refresh loop.
 * A tool without a source, or a failed fetch with nothing cached, yields an empty list (the UI
 * then offers free text).
 */
export async function loadRegistryVersions(
  database: Db,
  id: string,
  opts: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<string[]> {
  if (!registryVersionSource(id)) return [];
  const now = opts.now ?? new Date();
  const [row] = await database.select().from(toolLatest).where(eq(toolLatest.toolId, id));
  const fresh =
    row?.checkedAt && !row.error && now.getTime() - row.checkedAt.getTime() < TOOL_LATEST_TTL_MS;
  if (row && fresh) return row.versions;
  const last = failedAt.get(id);
  if (last !== undefined && now.getTime() - last < REGISTRY_VERSIONS_NEGATIVE_TTL_MS) {
    return row?.versions ?? [];
  }
  try {
    const info = await fetchRegistryVersions(id, opts.fetchImpl ?? httpFetch);
    await upsertToolLatest(database, id as ToolId, { info }, now);
    failedAt.delete(id);
    return info.versions;
  } catch (e) {
    failedAt.set(id, now.getTime());
    try {
      await upsertToolLatest(database, id as ToolId, {
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // the cache row is best effort; the caller still gets the last known versions
    }
    return row?.versions ?? [];
  }
}
