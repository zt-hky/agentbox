import { describe, expect, it } from "vitest";
import { gateMessage, planStatus, trialLeftText } from "../lib/plan-status";
import { creditsToVnd, formatCredits, formatVnd } from "../lib/money";

const free = {
  kind: "free" as const,
  allowanceRuntimeHours: 30,
  allowanceCpuCoreHours: 30,
  allowanceMemGbHours: 60,
  dailyRuntimeHours: 6,
};
const sub = {
  trialEndsAt: new Date("2026-03-15T08:00:00Z"),
  dayStart: "2026-03-10",
  usedTodayRuntimeHours: 1 + 50 / 60,
  usedRuntimeHours: 3,
  usedCpuCoreHours: 3,
  usedMemGbHours: 6,
};

describe("trialLeftText", () => {
  const end = new Date("2026-03-15T08:00:00Z");
  it("counts whole days, then hours and minutes", () => {
    expect(trialLeftText(new Date("2026-03-12T04:00:00Z"), end)).toBe("3 days left");
    expect(trialLeftText(new Date("2026-03-14T04:00:00Z"), end)).toBe("1 day left");
    expect(trialLeftText(new Date("2026-03-15T03:50:00Z"), end)).toBe("4 h 10 min left");
  });
  it("ends exactly at the boundary", () => {
    expect(trialLeftText(end, end)).toBe("Trial ended");
    expect(trialLeftText(new Date(end.getTime() - 1000), end)).toBe("1 s left");
  });
});

describe("planStatus", () => {
  // 10 March 2026 15:00 Vietnam time
  const now = new Date("2026-03-10T08:00:00Z");
  it("shows the trial countdown and what is left today", () => {
    const s = planStatus({ plan: free, sub, balanceMicro: 0n, now });
    expect(s.trialText).toBe("5 days left");
    expect(s.dailyText).toBe("4 h 10 min left today");
    expect(s.runtimeLeftHours).toBe(27);
    expect(s.gate).toEqual({ canWake: true, reason: null });
  });
  it("treats a stale day counter as a fresh day", () => {
    const s = planStatus({
      plan: free,
      sub: { ...sub, dayStart: "2026-03-09" },
      balanceMicro: 0n,
      now,
    });
    expect(s.dailyText).toBe("6 h left today");
  });
  it("reports the daily limit with the 00:00 Vietnam resume time", () => {
    const s = planStatus({
      plan: free,
      sub: { ...sub, usedTodayRuntimeHours: 6 },
      balanceMicro: 0n,
      now,
    });
    expect(s.dailyText).toBe("0 s left today");
    expect(s.gate).toEqual({
      canWake: false,
      reason: "daily_limit",
      resumesAt: new Date("2026-03-10T17:00:00Z"),
    });
    expect(gateMessage(s.gate, free)).toMatch(/Today's 6 hours are used\. Back at 00:00/);
  });
  it("has no trial or daily text on a package plan", () => {
    const pro = {
      ...free,
      kind: "package" as const,
      dailyRuntimeHours: null,
      allowanceRuntimeHours: 200,
    };
    const s = planStatus({ plan: pro, sub: { ...sub, trialEndsAt: null }, balanceMicro: 0n, now });
    expect(s.trialText).toBeNull();
    expect(s.dailyText).toBeNull();
    expect(s.runtimeLeftHours).toBe(197);
  });
  it("blocks after the trial", () => {
    const s = planStatus({
      plan: free,
      sub,
      balanceMicro: 0n,
      now: new Date("2026-03-15T08:00:00Z"),
    });
    expect(s.gate.reason).toBe("trial_ended");
    expect(gateMessage(s.gate, free)).toMatch(/trial has ended/);
  });
});

describe("money display", () => {
  it("formats dong with vi-VN grouping", () => {
    expect(formatVnd(139000)).toBe("139.000 ₫");
    expect(formatVnd(600)).toBe("600 ₫");
    expect(formatVnd(1019.6)).toBe("1.020 ₫");
  });
  it("shows credits with the dong equivalent", () => {
    expect(formatCredits(139_000_000n, "credit", 1000)).toBe("139 credits (139.000 ₫)");
    expect(formatCredits(1_000_000n, "credit", 1000)).toBe("1 credit (1.000 ₫)");
    expect(formatCredits(600_000n, "credit", 1000)).toBe("0.6 credits (600 ₫)");
    expect(formatCredits(150_000n, "credit", 1000)).toBe("0.15 credits (150 ₫)");
    expect(formatCredits(0n, "credit", 1000)).toBe("0 credits (0 ₫)");
    expect(formatCredits(2_500_000n, "credit")).toBe("2.5 credits");
    expect(creditsToVnd(249_000_000n, 1000)).toBe(249000);
  });
});
