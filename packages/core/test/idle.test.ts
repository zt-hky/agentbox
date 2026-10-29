import { describe, expect, it } from "vitest";
import { evaluateActivity, type IdleConfig } from "../src/idle.ts";

const config: IdleConfig = {
  idleTimeoutMinutes: 30,
  idleCpuPercent: 5,
  idleNetBytesPerMin: 32768,
  maxAwakeHours: 24,
};
const now = new Date("2026-01-02T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

const base = {
  now,
  lastActivityAt: ago(60),
  lastRequestAt: ago(60) as Date | null,
  cpuPercent: 0,
  netBytesPerMin: 0,
  awakeSince: ago(120),
  config,
};

describe("evaluateActivity", () => {
  const rows: [string, Partial<typeof base>, { active: boolean; stopReason: string | null }][] = [
    ["fully idle past timeout", {}, { active: false, stopReason: "idle" }],
    ["idle but within timeout", { lastActivityAt: ago(10) }, { active: false, stopReason: null }],
    [
      "exactly at timeout stops",
      { lastActivityAt: ago(30) },
      { active: false, stopReason: "idle" },
    ],
    ["recent request keeps active", { lastRequestAt: ago(5) }, { active: true, stopReason: null }],
    [
      "request exactly at timeout is not active",
      { lastRequestAt: ago(30) },
      { active: false, stopReason: "idle" },
    ],
    ["null request", { lastRequestAt: null }, { active: false, stopReason: "idle" }],
    ["cpu at threshold", { cpuPercent: 5 }, { active: true, stopReason: null }],
    ["cpu below threshold", { cpuPercent: 4.9 }, { active: false, stopReason: "idle" }],
    ["net at threshold", { netBytesPerMin: 32768 }, { active: true, stopReason: null }],
    ["net below threshold", { netBytesPerMin: 32767 }, { active: false, stopReason: "idle" }],
    [
      "max_awake wins even when active",
      { cpuPercent: 90, awakeSince: ago(24 * 60) },
      { active: true, stopReason: "max_awake" },
    ],
    [
      "just under max awake",
      { cpuPercent: 90, awakeSince: ago(24 * 60 - 1) },
      { active: true, stopReason: null },
    ],
    [
      "maxAwakeHours 0 disables",
      { cpuPercent: 90, awakeSince: ago(100 * 60), config: { ...config, maxAwakeHours: 0 } },
      { active: true, stopReason: null },
    ],
  ];
  it.each(rows)("%s", (_n, over, expected) => {
    expect(evaluateActivity({ ...base, ...over })).toEqual(expected);
  });
});
