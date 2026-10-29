import { describe, expect, it } from "vitest";
import { cpuCoresFromSample, readingFromHostStats, STATS_MAX_AGE_MS } from "../lib/live-stats";

const now = new Date("2026-01-01T12:00:00Z");
const fresh = new Date(now.getTime() - 30_000);
const payload = {
  host: {},
  workspaces: [
    { ws: "etoe", running: true, memoryCurrent: 123, cpuUsageUsec: 1 },
    { ws: "other", running: false, memoryCurrent: 0 },
  ],
  tenants: [{ ws: "etoe", uid: 200001, diskUsedBytes: 456, diskLimitBytes: 1000 }],
};

describe("readingFromHostStats", () => {
  it("returns only the requested workspace, with disk from tenants", () => {
    expect(readingFromHostStats(payload, fresh, "etoe", now)).toEqual({
      running: true,
      memBytes: 123,
      diskBytes: 456,
    });
  });

  it("leaves disk null when the payload predates tenants", () => {
    const old = { host: payload.host, workspaces: payload.workspaces };
    expect(readingFromHostStats(old, fresh, "etoe", now)?.diskBytes).toBeNull();
  });

  it("returns null for stale, unknown, or malformed snapshots", () => {
    const stale = new Date(now.getTime() - STATS_MAX_AGE_MS - 1);
    expect(readingFromHostStats(payload, stale, "etoe", now)).toBeNull();
    expect(readingFromHostStats(payload, fresh, "nobody", now)).toBeNull();
    expect(readingFromHostStats({ workspaces: "x" }, fresh, "etoe", now)).toBeNull();
  });
});

describe("cpuCoresFromSample", () => {
  it("divides core-seconds by the sampled interval", () => {
    expect(cpuCoresFromSample({ cpuCoreSec: 30, runtimeSec: 60 })).toBe(0.5);
  });
  it("is null without a usable sample", () => {
    expect(cpuCoresFromSample(null)).toBeNull();
    expect(cpuCoresFromSample({ cpuCoreSec: 1, runtimeSec: 0 })).toBeNull();
  });
});
