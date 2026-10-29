import { describe, expect, it } from "vitest";
import { parseKeyed, parseMeminfo, parseSingle } from "../src/cgroup.ts";
import { isSafeCgroupPath } from "../src/safe.ts";
import { summarizeTrivy } from "../src/trivy.ts";

describe("cgroup parsing", () => {
  it("reads keyed values", () => {
    const cpu = "usage_usec 123456\nuser_usec 100\nsystem_usec 23\nnr_periods 0\n";
    expect(parseKeyed(cpu, "usage_usec")).toBe(123456);
    expect(parseKeyed(cpu, "missing")).toBeNull();
    const ev = "low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\noom_group_kill 0\n";
    expect(parseKeyed(ev, "oom_kill")).toBe(1);
    expect(parseKeyed(ev, "oom")).toBe(2);
  });

  it("reads single-integer files and rejects 'max'", () => {
    expect(parseSingle("536870912\n")).toBe(536870912);
    expect(parseSingle("max\n")).toBeNull();
  });

  it("parses /proc/meminfo into bytes", () => {
    const t = "MemTotal:       31457280 kB\nMemFree: 1 kB\nMemAvailable:   20971520 kB\n";
    expect(parseMeminfo(t)).toEqual({
      memTotalBytes: 31457280 * 1024,
      memAvailableBytes: 20971520 * 1024,
    });
  });

  it("validates cgroup paths", () => {
    expect(
      isSafeCgroupPath(
        "/user.slice/user-204998.slice/user@204998.service/user.slice/libpod-ab.scope",
      ),
    ).toBe(true);
    expect(isSafeCgroupPath("relative/path")).toBe(false);
    expect(isSafeCgroupPath("/a/../b")).toBe(false);
    expect(isSafeCgroupPath("/a/\nb")).toBe(false);
  });
});

describe("trivy summary", () => {
  it("counts severities and fixable criticals", () => {
    const json = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            { Severity: "CRITICAL", FixedVersion: "1.2" },
            { Severity: "CRITICAL" },
            { Severity: "HIGH", FixedVersion: "3" },
            { Severity: "weird" },
          ],
        },
        { Vulnerabilities: null },
        {},
      ],
    });
    expect(summarizeTrivy(json)).toEqual({
      counts: { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 1 },
      fixableCritical: 1,
    });
    expect(summarizeTrivy("{}")).toEqual({
      counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
      fixableCritical: 0,
    });
  });
});
