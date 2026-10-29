import { z } from "zod";

/** Stats older than this are shown as "no data" rather than as live readings. */
export const STATS_MAX_AGE_MS = 5 * 60_000;

const payloadSchema = z.looseObject({
  workspaces: z
    .array(
      z.looseObject({
        ws: z.string(),
        running: z.boolean(),
        memoryCurrent: z.number(),
      }),
    )
    .default([]),
  // Present once the agent reports xfs quota usage; older payloads have no tenants.
  tenants: z.array(z.looseObject({ ws: z.string(), diskUsedBytes: z.number() })).default([]),
});

export interface WorkspaceReading {
  running: boolean;
  memBytes: number;
  diskBytes: number | null;
}

/** Picks one workspace's reading out of the `host_stats.payload` snapshot; null if absent or stale. */
export function readingFromHostStats(
  payload: unknown,
  updatedAt: Date,
  slug: string,
  now: Date = new Date(),
): WorkspaceReading | null {
  if (now.getTime() - updatedAt.getTime() > STATS_MAX_AGE_MS) return null;
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const w = parsed.data.workspaces.find((x) => x.ws === slug);
  if (!w) return null;
  const t = parsed.data.tenants.find((x) => x.ws === slug);
  return { running: w.running, memBytes: w.memoryCurrent, diskBytes: t?.diskUsedBytes ?? null };
}

/** Average cores busy over the last metering interval. */
export function cpuCoresFromSample(
  sample: { cpuCoreSec: number; runtimeSec: number } | null,
): number | null {
  if (!sample || sample.runtimeSec <= 0) return null;
  return sample.cpuCoreSec / sample.runtimeSec;
}
