import { describe, expect, it } from "vitest";
import {
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  buildRackRow,
  cpuCoresFromFreshSample,
  fillUsageBuckets,
  filterRackRows,
  formatProcessTable,
  indexHostStats,
  jobDurationSec,
  nextPollDelayMs,
  parseUsageRange,
  sortRackRows,
  statusCounts,
  uptimeSec,
  type RackRow,
} from "../lib/admin/workspaces";
import { STATS_MAX_AGE_MS } from "../lib/live-stats";

const now = new Date("2026-03-01T12:00:00Z");
const fresh = new Date(now.getTime() - 30_000);
const GB = 1024 ** 3;

const payload = {
  workspaces: [
    {
      ws: "alpha",
      running: true,
      memoryCurrent: 2 * GB,
      pidsCurrent: 40,
      oomKills: 1,
      startedAt: "2026-03-01T09:00:00Z",
      gatewayBytesDelta: 10,
      egressBytesDelta: 20,
    },
    { ws: "beta", running: false, memoryCurrent: 0 },
  ],
  tenants: [
    {
      ws: "alpha",
      uid: 200001,
      diskUsedBytes: 5 * GB,
      diskLimitBytes: 20 * GB,
      inodesUsed: 10,
      inodesLimit: 100,
    },
    {
      ws: "beta",
      uid: 200002,
      diskUsedBytes: GB,
      diskLimitBytes: 0,
      inodesUsed: 1,
      inodesLimit: 0,
    },
    {
      ws: "gamma",
      uid: 200003,
      diskUsedBytes: 0,
      diskLimitBytes: 20 * GB,
      inodesUsed: 0,
      inodesLimit: 5,
    },
  ],
};

describe("indexHostStats", () => {
  it("merges cgroup readings with tenant quota per workspace", () => {
    const idx = indexHostStats(payload, fresh, now)!;
    expect(idx.byWorkspace.get("alpha")).toMatchObject({
      running: true,
      memBytes: 2 * GB,
      pids: 40,
      diskUsedBytes: 5 * GB,
      diskLimitBytes: 20 * GB,
      inodesUsed: 10,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });
  });

  it("keeps quota for tenants that are not running", () => {
    const idx = indexHostStats(payload, fresh, now)!;
    expect(idx.byWorkspace.get("gamma")).toMatchObject({ running: false, diskLimitBytes: 20 * GB });
  });

  it("tolerates payloads from before tenants and startedAt existed", () => {
    const old = { workspaces: [{ ws: "alpha", running: true, memoryCurrent: 7 }] };
    expect(indexHostStats(old, fresh, now)!.byWorkspace.get("alpha")).toMatchObject({
      memBytes: 7,
      diskUsedBytes: null,
      startedAt: null,
    });
  });

  it("returns null for stale, missing or malformed snapshots", () => {
    expect(indexHostStats(payload, new Date(now.getTime() - STATS_MAX_AGE_MS - 1), now)).toBeNull();
    expect(indexHostStats(payload, null, now)).toBeNull();
    expect(indexHostStats({ workspaces: "nope" }, fresh, now)).toBeNull();
  });
});

describe("uptimeSec", () => {
  const started = new Date("2026-03-01T09:00:00Z");
  const awake = new Date("2026-03-01T11:00:00Z");
  it("prefers the container start over awake_since", () => {
    expect(uptimeSec("running", started, awake, now)).toBe(3 * 3600);
    expect(uptimeSec("running", null, awake, now)).toBe(3600);
  });
  it("is null unless running or without a start time", () => {
    expect(uptimeSec("sleeping", started, awake, now)).toBeNull();
    expect(uptimeSec("running", null, null, now)).toBeNull();
  });
  it("never goes negative on clock skew", () => {
    expect(uptimeSec("running", new Date(now.getTime() + 5000), null, now)).toBe(0);
  });
});

describe("cpuCoresFromFreshSample", () => {
  it("averages cores over the interval and drops stale or empty samples", () => {
    expect(cpuCoresFromFreshSample({ ts: fresh, cpuCoreSec: 30, runtimeSec: 60 }, now)).toBe(0.5);
    expect(
      cpuCoresFromFreshSample(
        { ts: new Date(now.getTime() - STATS_MAX_AGE_MS - 1), cpuCoreSec: 1, runtimeSec: 60 },
        now,
      ),
    ).toBeNull();
    expect(cpuCoresFromFreshSample({ ts: fresh, cpuCoreSec: 0, runtimeSec: 0 }, now)).toBeNull();
    expect(cpuCoresFromFreshSample(undefined, now)).toBeNull();
  });
});

const plan = { cpus: 2, memBytes: 4 * GB, diskBytes: 10 * GB };
const idx = indexHostStats(payload, fresh, now)!;
const mk = (slug: string, status: string, over: Partial<Parameters<typeof buildRackRow>[0]> = {}) =>
  buildRackRow({
    slug,
    ownerEmail: `${slug}@example.com`,
    planName: "Pro",
    status,
    slot: 1,
    lastActivityAt: null,
    awakeSince: null,
    plan,
    host: idx.byWorkspace.get(slug),
    cpuCores: null,
    ...over,
  });

describe("buildRackRow", () => {
  it("shows live meters only while running and uses the quota limit the agent reports", () => {
    const r = mk("alpha", "running", { cpuCores: 1.5 });
    expect(r).toMatchObject({ cpuCores: 1.5, memBytes: 2 * GB, diskBytes: 5 * GB });
    expect(r.limits).toEqual({ cpus: 2, memBytes: 4 * GB, diskBytes: 20 * GB });
    expect(r.awakeSince).toBe("2026-03-01T09:00:00.000Z");
  });

  it("hides cpu/memory for sleeping workspaces but keeps disk, and falls back to the plan disk limit", () => {
    const r = mk("beta", "sleeping", { cpuCores: 3 });
    expect(r).toMatchObject({ cpuCores: null, memBytes: null, diskBytes: GB });
    expect(r.limits?.diskBytes).toBe(10 * GB);
  });

  it("does not show memory for a workspace the agent reports as stopped", () => {
    expect(mk("beta", "running").memBytes).toBeNull();
  });

  it("has no limits without a plan and no readings without host stats", () => {
    const r = mk("nohost", "running", { plan: null, host: undefined });
    expect(r).toMatchObject({ limits: null, memBytes: null, diskBytes: null });
  });
});

describe("rack filtering and sorting", () => {
  const rows: RackRow[] = [
    mk("alpha", "running", { cpuCores: 1.5, lastActivityAt: new Date("2026-03-01T11:00:00Z") }),
    mk("beta", "sleeping", { lastActivityAt: new Date("2026-03-01T11:30:00Z") }),
    mk("gamma", "error"),
    mk("nohost", "running", { host: undefined, cpuCores: 0.1 }),
  ];

  it("filters by status and by slug or email, case-insensitively", () => {
    expect(filterRackRows(rows, { status: "running", query: "" }).map((r) => r.slug)).toEqual([
      "alpha",
      "nohost",
    ]);
    expect(
      filterRackRows(rows, { status: "all", query: " GAMMA@EXAMPLE " }).map((r) => r.slug),
    ).toEqual(["gamma"]);
    expect(filterRackRows(rows, { status: "error", query: "alpha" })).toEqual([]);
  });

  it("sorts metrics high to low with unknown readings last, and does not mutate the input", () => {
    const before = rows.map((r) => r.slug);
    expect(sortRackRows(rows, "cpu").map((r) => r.slug)).toEqual([
      "alpha",
      "nohost",
      "beta",
      "gamma",
    ]);
    expect(sortRackRows(rows, "memory").map((r) => r.slug)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "nohost",
    ]);
    expect(sortRackRows(rows, "activity").map((r) => r.slug)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "nohost",
    ]);
    expect(sortRackRows(rows, "slug").map((r) => r.slug)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "nohost",
    ]);
    expect(rows.map((r) => r.slug)).toEqual(before);
  });

  it("counts statuses in lifecycle order after the total", () => {
    expect(statusCounts(rows)).toEqual([
      { status: "all", count: 4 },
      { status: "running", count: 2 },
      { status: "sleeping", count: 1 },
      { status: "error", count: 1 },
    ]);
  });
});

describe("diagnostic job polling", () => {
  it("polls every 2 s while queued or running", () => {
    expect(nextPollDelayMs("queued", 0)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs("running", POLL_GIVE_UP_MS - 1)).toBe(POLL_INTERVAL_MS);
    expect(POLL_INTERVAL_MS).toBe(2000);
  });
  it("stops when the job is done or failed, unknown, or the budget is spent", () => {
    expect(nextPollDelayMs("done", 0)).toBeNull();
    expect(nextPollDelayMs("failed", 0)).toBeNull();
    expect(nextPollDelayMs(null, 0)).toBeNull();
    expect(nextPollDelayMs("running", POLL_GIVE_UP_MS)).toBeNull();
  });
});

describe("jobDurationSec", () => {
  it("is queued-to-finished and null while unfinished", () => {
    expect(
      jobDurationSec({ createdAt: "2026-03-01T12:00:00Z", finishedAt: "2026-03-01T12:00:07Z" }),
    ).toBe(7);
    expect(jobDurationSec({ createdAt: "2026-03-01T12:00:00Z", finishedAt: null })).toBeNull();
  });
});

describe("fillUsageBuckets", () => {
  const from = new Date("2026-03-01T10:00:00Z");
  const to = new Date("2026-03-01T11:00:00Z");
  it("pads every bucket so idle stretches are gaps and averages by runtime", () => {
    const t = Date.parse("2026-03-01T10:15:00Z");
    const out = fillUsageBuckets(
      [{ t, runtimeSec: 600, cpuCoreSec: 300, memGbSec: 1200, chargeMicro: 2_500_000n }],
      from,
      to,
      15,
    );
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual({ t: "2026-03-01T10:15:00.000Z", cpuCores: 0.5, memGb: 2, charge: 2.5 });
    expect(out[0]).toMatchObject({ cpuCores: null, memGb: null, charge: 0 });
  });
  it("treats zero runtime as idle even when a charge exists", () => {
    const t = Date.parse("2026-03-01T10:00:00Z");
    const [p] = fillUsageBuckets(
      [{ t, runtimeSec: 0, cpuCoreSec: 0, memGbSec: 0, chargeMicro: 1_000_000n }],
      from,
      to,
      15,
    );
    expect(p).toMatchObject({ cpuCores: null, charge: 1 });
  });
  it("parses the range param defensively", () => {
    expect(parseUsageRange("7d")).toBe("7d");
    expect(parseUsageRange("bogus")).toBe("24h");
    expect(parseUsageRange(undefined)).toBe("24h");
  });
});

describe("formatProcessTable", () => {
  it("lists the busiest process first under an aligned header", () => {
    const text = formatProcessTable([
      { pid: 2, user: "abx", cpu: 0.5, mem: 1, elapsed: "01:00", command: "sleep 1" },
      {
        pid: 1,
        user: "abx",
        cpu: 12.34,
        mem: 2.5,
        elapsed: "2-03:04:05",
        command: "node server.js",
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\s+PID {2}USER {2} %CPU {2} %MEM {2}ELAPSED {2,}COMMAND$/);
    expect(lines[1]).toContain("node server.js");
    expect(lines[1]).toContain("12.3");
    expect(lines[2]).toContain("sleep 1");
  });
  it("says so when nothing is running", () => {
    expect(formatProcessTable([])).toBe("No processes are running.");
  });
});
