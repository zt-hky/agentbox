import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeLogStreams,
  parseNftCounters,
  parsePodmanTime,
  parsePodmanTop,
  parseXfsQuotaReport,
} from "../src/diagnostics.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseXfsQuotaReport", () => {
  it("returns used/limit bytes and inodes for tenant uids only", () => {
    const rows = parseXfsQuotaReport(fixture("xfs-quota-report.txt"));
    expect([...rows.keys()].sort()).toEqual([200001, 200002, 200003]);
    expect(rows.get(200001)).toEqual({
      uid: 200001,
      diskUsedBytes: 142400 * 1024,
      diskLimitBytes: 52428800 * 1024,
      inodesUsed: 259,
      inodesLimit: 4000000,
    });
  });

  it("ignores blank and malformed lines", () => {
    expect(parseXfsQuotaReport("\n#abc 1 2 3\nnot a row\n").size).toBe(0);
  });
});

describe("parsePodmanTop", () => {
  it("parses columns and keeps the whole command line", () => {
    const ps = parsePodmanTop(fixture("podman-top.txt"));
    expect(ps).toHaveLength(6);
    expect(ps[0]).toEqual({
      pid: 1,
      user: "kyle",
      cpu: 0,
      mem: 0,
      elapsed: expect.stringMatching(/^\d\d:\d\d$/),
      command: "/run/podman-init -- /opt/agentbox/bin/workspace-init",
    });
    expect(ps[4]?.command).toContain("t3 serve --host 0.0.0.0 --port 3773");
    expect(ps[4]?.cpu).toBeGreaterThan(0);
  });

  it("handles day-long elapsed values and caps the row count", () => {
    const out = `PID USER %CPU %MEM ELAPSED COMMAND\n 9 root 1.5 2.5 1-02:03:04 sleep 1\n 10 root 0.0 0.0 00:01 x\n`;
    expect(parsePodmanTop(out)[0]).toMatchObject({ pid: 9, elapsed: "1-02:03:04", cpu: 1.5 });
    expect(parsePodmanTop(out, 1)).toHaveLength(1);
  });
});

describe("parseNftCounters", () => {
  it("sums blocked sets and reads smtp/ipv6 drops from the real chain listing", () => {
    expect(parseNftCounters(fixture("nft-output-chain.txt"))).toEqual({
      blockedPackets: 454,
      smtpPackets: 38,
      ipv6Packets: 8806,
    });
  });

  it("returns zeros for empty output", () => {
    expect(parseNftCounters("")).toEqual({ blockedPackets: 0, smtpPackets: 0, ipv6Packets: 0 });
  });
});

describe("mergeLogStreams", () => {
  it("interleaves stdout and stderr by timestamp and keeps the last N lines", () => {
    const out = "2026-01-01T00:00:01Z a\n2026-01-01T00:00:03Z c\n";
    const err = "2026-01-01T00:00:02Z b\n2026-01-01T00:00:04Z d\n";
    expect(mergeLogStreams(out, err, 100)).toBe(
      "2026-01-01T00:00:01Z a\n2026-01-01T00:00:02Z b\n2026-01-01T00:00:03Z c\n2026-01-01T00:00:04Z d",
    );
    expect(mergeLogStreams(out, err, 2)).toBe("2026-01-01T00:00:03Z c\n2026-01-01T00:00:04Z d");
  });
});

describe("parsePodmanTime", () => {
  it("converts Go time strings to ISO and rejects zero values", () => {
    expect(parsePodmanTime("2026-10-29 10:05:59.909191158 +0000 UTC")).toBe(
      "2026-10-29T10:05:59.909Z",
    );
    expect(parsePodmanTime("2026-10-29 17:05:59 +0700 +07")).toBe("2026-10-29T10:05:59.000Z");
    expect(parsePodmanTime("0001-01-01 00:00:00 +0000 UTC")).toBeNull();
    expect(parsePodmanTime("")).toBeNull();
  });
});
