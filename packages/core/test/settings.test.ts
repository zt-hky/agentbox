import { describe, expect, it } from "vitest";
import { parseSetting } from "../src/settings.ts";

const id = "00000000-0000-4000-8000-000000000001";

describe("settings schemas", () => {
  const ok: [Parameters<typeof parseSetting>[0], unknown][] = [
    [
      "hibernation",
      { idleTimeoutMinutes: 30, idleCpuPercent: 5, idleNetBytesPerMin: 32768, maxAwakeHours: 24 },
    ],
    ["capacity", { maxRunningMemoryRatio: 0.8 }],
    ["billing", { creditLabel: "credit", defaultPlanId: id }],
  ];
  it.each(ok)("accepts %s", (k, v) => expect(parseSetting(k, v)).toEqual(v));
  const bad: [Parameters<typeof parseSetting>[0], unknown][] = [
    [
      "hibernation",
      { idleTimeoutMinutes: 0, idleCpuPercent: 5, idleNetBytesPerMin: 1, maxAwakeHours: 1 },
    ],
    ["hibernation", {}],
    ["capacity", { maxRunningMemoryRatio: 1.5 }],
    ["capacity", { maxRunningMemoryRatio: 0 }],
    ["billing", { creditLabel: "", defaultPlanId: id }],
    ["billing", { creditLabel: "c", defaultPlanId: "nope" }],
  ];
  it.each(bad)("rejects %s %#", (k, v) => expect(() => parseSetting(k, v)).toThrow());
});
