import {
  CATALOG,
  TOOL_LATEST_TTL_MS,
  fetchLatestInfo,
  type FetchLike,
  type ToolId,
} from "@agentbox/core/toolchain";
import { upsertToolLatest } from "@agentbox/db/toolchain";
import { errMessage } from "./log.ts";
import type { Ctx } from "./types.ts";

export const LATEST_INTERVAL_MS = TOOL_LATEST_TTL_MS;
export const LATEST_FIRST_RUN_MS = 15_000;
/** After a failed refresh the loop tries again sooner than the hourly cadence. */
export const LATEST_NEGATIVE_TTL_MS = 60_000;
export const LATEST_FETCH_TIMEOUT_MS = 20_000;

/** Global `fetch` with a per-request timeout, shaped as the catalog source parsers expect. */
export function timeoutFetch(timeoutMs = LATEST_FETCH_TIMEOUT_MS): FetchLike {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Refresh `tool_latest` for the given tools (all by default). A failed fetch keeps the previous
 * data and records the error. Returns the ids that failed.
 */
export async function refreshToolLatest(
  ctx: Ctx,
  ids?: readonly ToolId[],
  fetchImpl: FetchLike = timeoutFetch(),
): Promise<ToolId[]> {
  const failed: ToolId[] = [];
  for (const entry of CATALOG) {
    if (ids && !ids.includes(entry.id)) continue;
    try {
      const info = await fetchLatestInfo(entry, fetchImpl);
      await upsertToolLatest(ctx.db, entry.id, { info }, ctx.now());
    } catch (e) {
      failed.push(entry.id);
      ctx.log.warn("tool latest refresh failed", { tool: entry.id, error: errMessage(e) });
      try {
        await upsertToolLatest(ctx.db, entry.id, { error: errMessage(e) }, ctx.now());
      } catch (e2) {
        ctx.log.error("could not record tool latest error", {
          tool: entry.id,
          error: errMessage(e2),
        });
      }
    }
  }
  return failed;
}

export interface LatestLoopOptions {
  fetch?: FetchLike;
  firstRunMs?: number;
  intervalMs?: number;
  negativeTtlMs?: number;
}

export function startLatestLoop(ctx: Ctx, opts: LatestLoopOptions = {}): () => void {
  const fetchImpl = opts.fetch ?? timeoutFetch();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    refreshToolLatest(ctx, undefined, fetchImpl)
      .then((failed) => failed.length > 0)
      .catch((e) => {
        ctx.log.error("tool latest loop failed", { error: errMessage(e) });
        return true;
      })
      .then((hadFailure) => {
        if (!stopped)
          timer = setTimeout(
            run,
            hadFailure
              ? (opts.negativeTtlMs ?? LATEST_NEGATIVE_TTL_MS)
              : (opts.intervalMs ?? LATEST_INTERVAL_MS),
          );
      });
  };
  timer = setTimeout(run, opts.firstRunMs ?? LATEST_FIRST_RUN_MS);
  return () => {
    stopped = true;
    clearTimeout(timer ?? undefined);
  };
}
