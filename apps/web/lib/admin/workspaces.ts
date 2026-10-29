import { z } from "zod";
import { STATS_MAX_AGE_MS } from "../live-stats";

/**
 * Pure helpers for the admin workspace pages: host_stats parsing, rack rows, filtering and sorting,
 * uptime, job views and the diagnostic-job polling state machine. No database access here.
 */

/* ---------- host_stats ---------- */

// Loose on purpose: older payloads predate tenants/startedAt/pids, and the page must still render.
const statsSchema = z.looseObject({
  workspaces: z
    .array(
      z.looseObject({
        ws: z.string(),
        running: z.boolean(),
        memoryCurrent: z.number(),
        pidsCurrent: z.number().optional(),
        oomKills: z.number().optional(),
        startedAt: z.string().nullable().optional(),
        gatewayBytesDelta: z.number().optional(),
        egressBytesDelta: z.number().optional(),
      }),
    )
    .default([]),
  tenants: z
    .array(
      z.looseObject({
        ws: z.string(),
        uid: z.number().optional(),
        diskUsedBytes: z.number(),
        diskLimitBytes: z.number().optional(),
        inodesUsed: z.number().optional(),
        inodesLimit: z.number().optional(),
      }),
    )
    .default([]),
});

export interface HostFacts {
  running: boolean;
  memBytes: number;
  pids: number | null;
  oomKills: number | null;
  startedAt: Date | null;
  gatewayBytesDelta: number | null;
  egressBytesDelta: number | null;
  diskUsedBytes: number | null;
  diskLimitBytes: number | null;
  inodesUsed: number | null;
  inodesLimit: number | null;
}

/** Index of one fresh `host_stats` snapshot by workspace slug; null when stale or unreadable. */
export interface HostIndex {
  byWorkspace: ReadonlyMap<string, HostFacts>;
}

export function indexHostStats(
  payload: unknown,
  updatedAt: Date | null | undefined,
  now: Date = new Date(),
): HostIndex | null {
  if (!updatedAt || now.getTime() - updatedAt.getTime() > STATS_MAX_AGE_MS) return null;
  const parsed = statsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const tenants = new Map(parsed.data.tenants.map((t) => [t.ws, t]));
  const byWorkspace = new Map<string, HostFacts>();
  // Tenants exist for every workspace (running or not); running ones add cgroup readings.
  for (const t of parsed.data.tenants) {
    byWorkspace.set(t.ws, {
      running: false,
      memBytes: 0,
      pids: null,
      oomKills: null,
      startedAt: null,
      gatewayBytesDelta: null,
      egressBytesDelta: null,
      diskUsedBytes: t.diskUsedBytes,
      diskLimitBytes: t.diskLimitBytes ?? null,
      inodesUsed: t.inodesUsed ?? null,
      inodesLimit: t.inodesLimit ?? null,
    });
  }
  for (const w of parsed.data.workspaces) {
    const t = tenants.get(w.ws);
    const startedAt = w.startedAt ? new Date(w.startedAt) : null;
    byWorkspace.set(w.ws, {
      running: w.running,
      memBytes: w.memoryCurrent,
      pids: w.pidsCurrent ?? null,
      oomKills: w.oomKills ?? null,
      startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
      gatewayBytesDelta: w.gatewayBytesDelta ?? null,
      egressBytesDelta: w.egressBytesDelta ?? null,
      diskUsedBytes: t?.diskUsedBytes ?? null,
      diskLimitBytes: t?.diskLimitBytes ?? null,
      inodesUsed: t?.inodesUsed ?? null,
      inodesLimit: t?.inodesLimit ?? null,
    });
  }
  return { byWorkspace };
}

/** Seconds a running workspace has been up: container start from the agent, else `awake_since`. */
export function uptimeSec(
  status: string,
  startedAt: Date | null | undefined,
  awakeSince: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (status !== "running") return null;
  const from = startedAt ?? awakeSince;
  if (!from) return null;
  return Math.max(0, (now.getTime() - from.getTime()) / 1000);
}

/** Cores busy over the last metering interval, null when the sample is missing or stale. */
export function cpuCoresFromFreshSample(
  sample: { ts: Date; cpuCoreSec: number; runtimeSec: number } | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!sample || sample.runtimeSec <= 0) return null;
  if (now.getTime() - sample.ts.getTime() > STATS_MAX_AGE_MS) return null;
  return sample.cpuCoreSec / sample.runtimeSec;
}

/* ---------- rack list ---------- */

export interface PlanLimits {
  cpus: number;
  memBytes: number;
  diskBytes: number;
}

export function planLimits(p: {
  cpuLimit: string | number;
  memoryLimitMb: number;
  diskLimitGb: number;
}): PlanLimits {
  return {
    cpus: Number(p.cpuLimit),
    memBytes: p.memoryLimitMb * 1024 * 1024,
    diskBytes: p.diskLimitGb * 1024 * 1024 * 1024,
  };
}

/** Serializable (ISO strings) so the rack can be a client component. */
export interface RackRow {
  slug: string;
  ownerEmail: string;
  planName: string | null;
  status: string;
  slot: number;
  lastActivityAt: string | null;
  awakeSince: string | null;
  cpuCores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  limits: PlanLimits | null;
}

export function buildRackRow(input: {
  slug: string;
  ownerEmail: string;
  planName: string | null;
  status: string;
  slot: number;
  lastActivityAt: Date | null;
  awakeSince: Date | null;
  plan: PlanLimits | null;
  host: HostFacts | undefined;
  cpuCores: number | null;
}): RackRow {
  const running = input.status === "running";
  const h = input.host;
  return {
    slug: input.slug,
    ownerEmail: input.ownerEmail,
    planName: input.planName,
    status: input.status,
    slot: input.slot,
    lastActivityAt: input.lastActivityAt?.toISOString() ?? null,
    // The agent's container start is the better uptime anchor; fall back to the DB.
    awakeSince: (h?.startedAt ?? input.awakeSince)?.toISOString() ?? null,
    cpuCores: running ? input.cpuCores : null,
    memBytes: running && h?.running ? h.memBytes : null,
    diskBytes: h?.diskUsedBytes ?? null,
    limits: input.plan
      ? { ...input.plan, diskBytes: h?.diskLimitBytes || input.plan.diskBytes }
      : null,
  };
}

export type RackSort = "slug" | "activity" | "cpu" | "memory" | "disk";
export const RACK_SORTS: { value: RackSort; label: string }[] = [
  { value: "slug", label: "Name" },
  { value: "activity", label: "Last activity" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  { value: "disk", label: "Disk" },
];

export function filterRackRows(
  rows: readonly RackRow[],
  opts: { status: string; query: string },
): RackRow[] {
  const q = opts.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (opts.status === "all" || r.status === opts.status) &&
      (q === "" || r.slug.toLowerCase().includes(q) || r.ownerEmail.toLowerCase().includes(q)),
  );
}

// Unknown readings always sort last, whichever way the metric runs.
const num = (n: number | null) => n ?? Number.NEGATIVE_INFINITY;

export function sortRackRows(rows: readonly RackRow[], sort: RackSort): RackRow[] {
  const out = [...rows];
  const byDesc = (f: (r: RackRow) => number | null) =>
    out.sort((a, b) => num(f(b)) - num(f(a)) || a.slug.localeCompare(b.slug));
  switch (sort) {
    case "slug":
      return out.sort((a, b) => a.slug.localeCompare(b.slug));
    case "activity":
      return byDesc((r) => (r.lastActivityAt ? Date.parse(r.lastActivityAt) : null));
    case "cpu":
      return byDesc((r) => r.cpuCores);
    case "memory":
      return byDesc((r) => r.memBytes);
    case "disk":
      return byDesc((r) => r.diskBytes);
  }
}

/** Status filter chips: "all" first, then statuses present, in lifecycle order. */
const STATUS_ORDER = [
  "running",
  "starting",
  "stopping",
  "provisioning",
  "sleeping",
  "error",
  "deleting",
  "deleted",
];
export function statusCounts(rows: readonly RackRow[]): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const known = STATUS_ORDER.filter((s) => counts.has(s));
  const other = [...counts.keys()].filter((s) => !STATUS_ORDER.includes(s)).sort();
  return [
    { status: "all", count: rows.length },
    ...[...known, ...other].map((status) => ({ status, count: counts.get(status)! })),
  ];
}

/* ---------- jobs ---------- */

export interface JobView {
  id: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  finishedAt: string | null;
}

export function jobActive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** Total time from enqueue to finish; null while active or when the worker predates `finished_at`. */
export function jobDurationSec(job: Pick<JobView, "createdAt" | "finishedAt">): number | null {
  if (!job.finishedAt) return null;
  const ms = Date.parse(job.finishedAt) - Date.parse(job.createdAt);
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : null;
}

export const POLL_INTERVAL_MS = 2000;
/** Stop polling after this long so a dead worker does not keep a tab hitting the server forever. */
export const POLL_GIVE_UP_MS = 120_000;

/** Next poll delay for a diagnostic job, or null to stop (job finished, or waited too long). */
export function nextPollDelayMs(status: string | null, waitedMs: number): number | null {
  if (status === null || !jobActive(status)) return null;
  if (waitedMs >= POLL_GIVE_UP_MS) return null;
  return POLL_INTERVAL_MS;
}

export const LOG_TAILS = [100, 500, 2000] as const;
export type LogTail = (typeof LOG_TAILS)[number];

/** `10..2000` is the worker's own range; the UI offers three presets. */
export function isLogTail(n: number): n is LogTail {
  return (LOG_TAILS as readonly number[]).includes(n);
}

/** Linux account naming used by the agent for tenants. */
export function linuxUser(slug: string): string {
  return `abx-${slug}`;
}

/* ---------- usage series ---------- */

export const USAGE_RANGES = {
  "24h": { label: "24 hours", spanMs: 24 * 3_600_000, bucketMin: 15 },
  "7d": { label: "7 days", spanMs: 7 * 24 * 3_600_000, bucketMin: 60 },
} as const;
export type UsageRange = keyof typeof USAGE_RANGES;

export function parseUsageRange(v: string | undefined): UsageRange {
  return v === "7d" ? "7d" : "24h";
}

export interface UsagePointRaw {
  /** Bucket start, ms since epoch. */
  t: number;
  runtimeSec: number;
  cpuCoreSec: number;
  memGbSec: number;
  chargeMicro: bigint;
}

export interface UsageChartPoint {
  /** Bucket start (ISO). */
  t: string;
  /** Average cores busy while running in this bucket; null when the workspace did not run. */
  cpuCores: number | null;
  /** Average memory in GB while running; null when it did not run. */
  memGb: number | null;
  /** Credits charged in this bucket (0 when idle). */
  charge: number;
}

/**
 * One point per bucket from `from` to `to` so the time axis is linear and idle stretches show as gaps.
 * Averages are weighted by runtime, not by sample count.
 */
export function fillUsageBuckets(
  raw: readonly UsagePointRaw[],
  from: Date,
  to: Date,
  bucketMin: number,
): UsageChartPoint[] {
  const step = bucketMin * 60_000;
  const byT = new Map(raw.map((r) => [r.t, r]));
  const first = Math.floor(from.getTime() / step) * step;
  const out: UsageChartPoint[] = [];
  for (let t = first; t <= to.getTime(); t += step) {
    const r = byT.get(t);
    const ran = r !== undefined && r.runtimeSec > 0;
    out.push({
      t: new Date(t).toISOString(),
      cpuCores: ran ? r.cpuCoreSec / r.runtimeSec : null,
      memGb: ran ? r.memGbSec / r.runtimeSec : null,
      charge: r ? Number(r.chargeMicro) / 1_000_000 : 0,
    });
  }
  return out;
}

/* ---------- process list ---------- */

export interface ProcessRow {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  elapsed: string;
  command: string;
}

/** Fixed-width `ps`-style text for the mono code block; busiest processes first. */
export function formatProcessTable(processes: readonly ProcessRow[]): string {
  if (processes.length === 0) return "No processes are running.";
  const rows = [...processes].sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  const userW = Math.max(4, ...rows.map((p) => p.user.length));
  const elapsedW = Math.max(7, ...rows.map((p) => p.elapsed.length));
  const head = `${"PID".padStart(7)}  ${"USER".padEnd(userW)}  ${"%CPU".padStart(5)}  ${"%MEM".padStart(5)}  ${"ELAPSED".padEnd(elapsedW)}  COMMAND`;
  const lines = rows.map(
    (p) =>
      `${String(p.pid).padStart(7)}  ${p.user.padEnd(userW)}  ${p.cpu.toFixed(1).padStart(5)}  ${p.mem.toFixed(1).padStart(5)}  ${p.elapsed.padEnd(elapsedW)}  ${p.command}`,
  );
  return [head, ...lines].join("\n");
}
