import { describe, expect, it } from "vitest";
import {
  ageSeconds,
  classifyAge,
  classifyQueue,
  computeCapacity,
  describeHeartbeat,
  describeServices,
  extractVersions,
  formatJobDuration,
  parseHostPayload,
  topBy,
} from "../lib/admin/system";
import { parseJobFilters } from "../lib/admin/system-jobs";

const GiB = 1024 ** 3;

describe("classifyAge", () => {
  it("is ok under two minutes, warn from two, down from five", () => {
    expect(classifyAge(0)).toBe("ok");
    expect(classifyAge(119)).toBe("ok");
    expect(classifyAge(120)).toBe("warn");
    expect(classifyAge(299)).toBe("warn");
    expect(classifyAge(300)).toBe("down");
  });
  it("is unknown without a timestamp", () => {
    expect(classifyAge(null)).toBe("unknown");
    expect(ageSeconds(null, new Date())).toBeNull();
    expect(ageSeconds("not a date", new Date())).toBeNull();
  });
  it("computes age from ISO strings and never goes negative", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    expect(ageSeconds("2026-01-01T00:08:00Z", now)).toBe(120);
    expect(ageSeconds(new Date("2026-01-01T00:11:00Z"), now)).toBe(0);
  });
});

describe("describeServices and heartbeat", () => {
  it("marks inactive services down and names the control plane", () => {
    const rows = describeServices([
      { name: "agentbox-agent", active: true },
      { name: "user@1002", active: false },
      { name: "odd-unit", active: true },
    ]);
    expect(rows.map((r) => r.health)).toEqual(["ok", "down", "ok"]);
    expect(rows[1]!.label).toBe("Control plane");
    expect(rows[2]!.label).toBe("odd-unit");
  });
  it("derives worker health from heartbeat age", () => {
    expect(describeHeartbeat(30).health).toBe("ok");
    expect(describeHeartbeat(200).health).toBe("warn");
    expect(describeHeartbeat(900).health).toBe("down");
    expect(describeHeartbeat(null).health).toBe("unknown");
  });
});

describe("classifyQueue", () => {
  it("is an outage when work is queued and the worker is down or silent", () => {
    expect(classifyQueue({ queued: 2, running: 0, failed24h: 0 }, "down").health).toBe("down");
    expect(classifyQueue({ queued: 1, running: 0, failed24h: 0 }, "unknown").health).toBe("down");
  });
  it("warns on recent failures and is ok otherwise", () => {
    expect(classifyQueue({ queued: 0, running: 1, failed24h: 3 }, "ok").health).toBe("warn");
    expect(classifyQueue({ queued: 4, running: 1, failed24h: 0 }, "ok").health).toBe("ok");
  });
  it("is unknown before the first heartbeat", () => {
    expect(classifyQueue(null, "unknown").health).toBe("unknown");
  });
});

describe("computeCapacity", () => {
  it("sums plan memory against ratio times host memory", () => {
    const c = computeCapacity({
      allocatedMb: [4096, 8192],
      memTotalBytes: 32 * GiB,
      maxRunningMemoryRatio: 0.5,
    });
    expect(c.allocatedBytes).toBe(12 * GiB);
    expect(c.capacityBytes).toBe(16 * GiB);
    expect(c.freeBytes).toBe(4 * GiB);
    expect(c.usedRatio).toBeCloseTo(0.75);
    expect(c.health).toBe("ok");
  });
  it("warns from 85% and is down at or over the ceiling", () => {
    const at = (mb: number) =>
      computeCapacity({
        allocatedMb: [mb],
        memTotalBytes: 10 * 1024 * 1024 * 1024,
        maxRunningMemoryRatio: 1,
      });
    expect(at(8800).health).toBe("warn");
    expect(at(10 * 1024).health).toBe("down");
    expect(at(12 * 1024).freeBytes).toBe(0);
  });
  it("is unknown when host memory is not known", () => {
    const c = computeCapacity({
      allocatedMb: [1024],
      memTotalBytes: null,
      maxRunningMemoryRatio: 0.8,
    });
    expect(c.capacityBytes).toBe(0);
    expect(c.usedRatio).toBe(0);
    expect(c.health).toBe("unknown");
  });
});

describe("topBy", () => {
  it("keeps the largest positive values and drops nulls and zeros", () => {
    const rows = [
      { slug: "b", cpu: 1 },
      { slug: "a", cpu: 1 },
      { slug: "c", cpu: 3 },
      { slug: "d", cpu: 0 },
      { slug: "e", cpu: null },
    ];
    expect(topBy(rows, (r) => r.cpu, 3).map((r) => r.slug)).toEqual(["c", "a", "b"]);
    expect(topBy(rows, (r) => r.cpu, 1)).toHaveLength(1);
  });
});

describe("formatJobDuration", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:10:00Z");
  it("uses created to finished for ended jobs", () => {
    const finishedAt = new Date("2026-01-01T00:00:42Z");
    expect(formatJobDuration({ status: "done", createdAt, finishedAt }, now)).toBe("42 s");
    expect(
      formatJobDuration(
        { status: "failed", createdAt, finishedAt: new Date("2026-01-01T01:12:00Z") },
        now,
      ),
    ).toBe("1 h 12 min");
  });
  it("says so when an ended job has no finish time", () => {
    expect(formatJobDuration({ status: "failed", createdAt, finishedAt: null }, now)).toBe(
      "not recorded",
    );
  });
  it("shows waiting and elapsed for active jobs", () => {
    expect(formatJobDuration({ status: "queued", createdAt, finishedAt: null }, now)).toBe(
      "waiting 10 min",
    );
    expect(formatJobDuration({ status: "running", createdAt, finishedAt: null }, now)).toBe(
      "10 min so far",
    );
  });
});

describe("parseHostPayload", () => {
  it("returns the worker heartbeat even when the stats are in an old shape", () => {
    const out = parseHostPayload({
      host: { cpus: 4 },
      worker: {
        heartbeatAt: "2026-01-01T00:00:00Z",
        queue: { queued: 1, running: 0, failed24h: 2 },
      },
    });
    expect(out.stats).toBeNull();
    expect(out.worker?.queue.failed24h).toBe(2);
  });
  it("returns nulls for garbage", () => {
    expect(parseHostPayload(null)).toEqual({ stats: null, worker: null });
  });
});

describe("extractVersions", () => {
  const json = `{
  "t3": { "ref": "omp-overlay", "commit": "0123456789abcdef", "version": "0.0.20" },
  "node": "v24.1.0",
  "gh": "2.60.0"
}`;
  it("finds the versions object printed in the build log", () => {
    const v = extractVersions(`STEP 40: RUN ...\n${json}\n--> abc123\n`);
    expect(v).toEqual([
      { label: "t3", value: "0.0.20, omp-overlay, 0123456789" },
      { label: "node", value: "v24.1.0" },
      { label: "gh", value: "2.60.0" },
    ]);
  });
  it("returns null when the log has no versions object", () => {
    expect(extractVersions('{\n  "other": 1\n}\n')).toBeNull();
    expect(extractVersions(null)).toBeNull();
  });
});

describe("parseJobFilters", () => {
  it("drops unknown statuses and types and clamps the page", () => {
    const f = parseJobFilters({ status: "bogus", type: "fetch_logs", ws: " MyDev ", page: "-4" });
    expect(f).toEqual({ status: undefined, type: "fetch_logs", ws: "mydev", page: 0 });
  });
});
