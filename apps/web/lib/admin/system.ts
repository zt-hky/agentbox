import {
  statsResponseSchema,
  workerHeartbeatSchema,
  type StatsResponse,
  type WorkerHeartbeat,
} from "@agentbox/core/agent-api";
import { formatDuration } from "../format";

/** Overall traffic-light verdict for one thing on the overview. */
export type Health = "ok" | "warn" | "down" | "unknown";

/** Worker and agent write every 60 s; two missed ticks is a warning, five is an outage. */
export const FRESHNESS = { warnSec: 120, downSec: 300 } as const;

export function classifyAge(
  ageSec: number | null,
  limits: { warnSec: number; downSec: number } = FRESHNESS,
): Health {
  if (ageSec === null || !Number.isFinite(ageSec)) return "unknown";
  if (ageSec >= limits.downSec) return "down";
  if (ageSec >= limits.warnSec) return "warn";
  return "ok";
}

export function ageSeconds(from: Date | string | null | undefined, now: Date): number | null {
  if (!from) return null;
  const t = from instanceof Date ? from.getTime() : Date.parse(from);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 1000));
}

/** Status-light key + accessible label for a health verdict (reuses the shared light palette). */
export function healthLight(h: Health): { status: string; label: string } {
  switch (h) {
    case "ok":
      return { status: "running", label: "Healthy" };
    case "warn":
      return { status: "starting", label: "Needs attention" };
    case "down":
      return { status: "failed", label: "Down" };
    case "unknown":
      return { status: "sleeping", label: "Unknown" };
  }
}

export interface ParsedHostStats {
  stats: StatsResponse | null;
  worker: WorkerHeartbeat | null;
}

/** Splits `host_stats.payload` into the agent stats and the worker heartbeat; each may be absent. */
export function parseHostPayload(payload: unknown): ParsedHostStats {
  const stats = statsResponseSchema.safeParse(payload);
  const raw = (payload as { worker?: unknown } | null | undefined)?.worker;
  const worker = workerHeartbeatSchema.safeParse(raw);
  return {
    stats: stats.success ? stats.data : null,
    worker: worker.success ? worker.data : null,
  };
}

export interface ServiceReport {
  name: string;
  label: string;
  meaning: string;
  health: Health;
  detail: string;
}

const SERVICE_COPY: { match: (n: string) => boolean; label: string; ok: string; down: string }[] = [
  {
    match: (n) => n === "agentbox-agent",
    label: "Host agent",
    ok: "Starts, stops and measures workspaces on this host.",
    down: "Workspaces cannot be started, stopped or measured until the agent is back.",
  },
  {
    match: (n) => n === "agentbox-storage",
    label: "Tenant storage",
    ok: "Disk quotas for workspace home folders are enforced.",
    down: "Workspace disks are not mounted or quotas are not applied; new workspaces will fail.",
  },
  {
    match: (n) => n === "agentbox-firewall",
    label: "Firewall",
    ok: "Outbound rules for workspaces are loaded.",
    down: "Workspaces may reach networks they should not. Restart the firewall unit now.",
  },
  {
    match: (n) => n.startsWith("user@"),
    label: "Control plane",
    ok: "The web app, database and worker run under this user session.",
    down: "The control-plane user session is stopped, so the web app and worker are down.",
  },
];

/** Service rows from `host.services`; unknown services are listed under their unit name. */
export function describeServices(services: { name: string; active: boolean }[]): ServiceReport[] {
  return services.map((s) => {
    const copy = SERVICE_COPY.find((c) => c.match(s.name));
    return {
      name: s.name,
      label: copy?.label ?? s.name,
      meaning: copy ? (s.active ? copy.ok : copy.down) : s.active ? "Running." : "Not running.",
      health: s.active ? "ok" : "down",
      detail: s.active ? "Active" : "Inactive",
    };
  });
}

export function describeHeartbeat(ageSec: number | null): ServiceReport {
  const health = classifyAge(ageSec);
  const meaning =
    health === "ok"
      ? "The worker runs jobs, meters usage and enforces idle sleep."
      : health === "warn"
        ? "The worker missed a metering tick. Jobs may be delayed; check the worker logs."
        : health === "down"
          ? "The worker has stopped: jobs are not running and usage is not metered. Restart it."
          : "No heartbeat has been recorded yet. The worker may never have started.";
  return {
    name: "worker",
    label: "Worker",
    meaning,
    health,
    detail: ageSec === null ? "No heartbeat" : `Last heartbeat ${formatDuration(ageSec)} ago`,
  };
}

export function describeStatsAge(ageSec: number | null): ServiceReport {
  const health = classifyAge(ageSec);
  const meaning =
    health === "ok"
      ? "Host and workspace readings are current."
      : health === "unknown"
        ? "No host readings have been stored yet."
        : "Readings are stale, so meters across the admin pages show no data. Check the worker's link to the agent.";
  return {
    name: "stats",
    label: "Host readings",
    meaning,
    health,
    detail: ageSec === null ? "No readings" : `Updated ${formatDuration(ageSec)} ago`,
  };
}

export interface QueueReport {
  health: Health;
  meaning: string;
}

/** Queue verdict: a dead worker with queued work is an outage; recent failures need a look. */
export function classifyQueue(
  queue: { queued: number; running: number; failed24h: number } | null,
  workerHealth: Health,
): QueueReport {
  if (!queue)
    return {
      health: "unknown",
      meaning: "Queue numbers appear after the worker's first heartbeat.",
    };
  if (queue.queued > 0 && (workerHealth === "down" || workerHealth === "unknown")) {
    return {
      health: "down",
      meaning: `${queue.queued} queued ${queue.queued === 1 ? "job is" : "jobs are"} waiting and the worker is not running them.`,
    };
  }
  if (queue.failed24h > 0) {
    return {
      health: "warn",
      meaning: `${queue.failed24h} ${queue.failed24h === 1 ? "job" : "jobs"} failed in the last 24 hours. Open Jobs to see why and retry.`,
    };
  }
  return { health: "ok", meaning: "Jobs are flowing and nothing failed in the last 24 hours." };
}

export interface Capacity {
  allocatedBytes: number;
  /** `maxRunningMemoryRatio × MemTotal`; 0 when the host size is unknown. */
  capacityBytes: number;
  freeBytes: number;
  /** allocated / capacity, 0 when capacity is unknown. */
  usedRatio: number;
  health: Health;
}

const MIB = 1024 * 1024;

/** Allocated plan memory of running + starting workspaces against the wake-up ceiling. */
export function computeCapacity(input: {
  allocatedMb: number[];
  memTotalBytes: number | null;
  maxRunningMemoryRatio: number;
}): Capacity {
  const allocatedBytes = input.allocatedMb.reduce((a, b) => a + b, 0) * MIB;
  const capacityBytes = input.memTotalBytes ? input.memTotalBytes * input.maxRunningMemoryRatio : 0;
  const usedRatio = capacityBytes > 0 ? allocatedBytes / capacityBytes : 0;
  const health: Health =
    capacityBytes <= 0 ? "unknown" : usedRatio >= 1 ? "down" : usedRatio >= 0.85 ? "warn" : "ok";
  return {
    allocatedBytes,
    capacityBytes,
    freeBytes: Math.max(0, capacityBytes - allocatedBytes),
    usedRatio,
    health,
  };
}

/** Largest `n` positive values, ties broken by slug for stable output. */
export function topBy<T extends { slug: string }>(
  rows: T[],
  pick: (row: T) => number | null,
  n: number,
): (T & { value: number })[] {
  return rows
    .map((r) => ({ ...r, value: pick(r) }))
    .filter((r): r is T & { value: number } => r.value !== null && r.value > 0)
    .sort((a, b) => b.value - a.value || a.slug.localeCompare(b.slug))
    .slice(0, n);
}

export interface JobTiming {
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Created-to-finished for ended jobs; elapsed so far for running ones; waiting time for queued ones. */
export function formatJobDuration(job: JobTiming, now: Date): string {
  const sec = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;
  if (job.status === "done" || job.status === "failed") {
    return job.finishedAt ? formatDuration(sec(job.createdAt, job.finishedAt)) : "not recorded";
  }
  const elapsed = formatDuration(sec(job.createdAt, now));
  return job.status === "queued" ? `waiting ${elapsed}` : `${elapsed} so far`;
}

/** Shortened JSON for table cells; full text is shown when a row is expanded. */
export function previewJson(value: unknown, max = 80): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type ImageVersions = { label: string; value: string }[];

/**
 * The workspace image's Containerfile prints `/opt/agentbox/versions.json` at the end of the build, so
 * it appears in the stored build log. Returns the tool list if that object is in the log, else null.
 */
export function extractVersions(log: string | null | undefined): ImageVersions | null {
  if (!log) return null;
  const matches = log.match(/^\{\s*\n[\s\S]*?\n\}\s*$/gm) ?? [];
  for (const candidate of matches.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("t3" in parsed)) continue;
    const out: ImageVersions = [];
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out.push({ label: key, value: v });
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const parts = (["version", "ref", "commit"] as const).flatMap((k) => {
          const part = o[k];
          if (typeof part !== "string" || !part) return [];
          return [k === "commit" ? part.slice(0, 10) : part.slice(0, 80)];
        });
        if (parts.length > 0) out.push({ label: key, value: parts.join(", ") });
      }
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

const EVENT_COPY: Record<string, { light: string; title: string }> = {
  started: { light: "running", title: "Started" },
  stopped: { light: "sleeping", title: "Stopped" },
  crashed: { light: "failed", title: "Crashed" },
  oom: { light: "failed", title: "Ran out of memory" },
  policy_violation: { light: "failed", title: "Broke a sandbox policy" },
  start_failed: { light: "failed", title: "Failed to start" },
  credits_exhausted: { light: "starting", title: "Stopped: credits ran out" },
  max_awake: { light: "starting", title: "Stopped: awake too long" },
};

/** Lamp key and plain title for a `workspace_events.type`. */
export function describeEvent(type: string): { light: string; title: string } {
  return EVENT_COPY[type] ?? { light: "sleeping", title: type.replaceAll("_", " ") };
}
