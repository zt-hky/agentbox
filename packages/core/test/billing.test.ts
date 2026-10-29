import { describe, expect, it } from "vitest";
import {
  computeCharge,
  localDateString,
  localDayStart,
  nextLocalDayStart,
  planGate,
  runtimeUsedToday,
  type Allowance,
  type PlanGateInput,
  type Prices,
} from "../src/billing.ts";

const prices: Prices = {
  runtimePerHour: 500_000n,
  cpuCorePerHour: 200_000n,
  memGbPerHour: 50_000n,
};
const zero: Allowance = { runtimeHours: 0, cpuCoreHours: 0, memGbHours: 0 };

describe("computeCharge", () => {
  it("Free plan: allowance 1 CPU-core-h, usage 1.5 CPU-core-h at 0.2 credit/h -> 100000", () => {
    const r = computeCharge({ runtimeSec: 0, cpuCoreSec: 1.5 * 3600, memGbSec: 0 }, prices, {
      runtimeHours: 0,
      cpuCoreHours: 1,
      memGbHours: 0,
    });
    expect(r.chargeMicro).toBe(100000n);
    expect(r.allowanceConsumed.cpuCoreHours).toBe(1);
  });
  const rows: [string, Parameters<typeof computeCharge>[0], Allowance, bigint, Allowance][] = [
    [
      "all within allowance",
      { runtimeSec: 3600, cpuCoreSec: 3600, memGbSec: 7200 },
      { runtimeHours: 20, cpuCoreHours: 20, memGbHours: 40 },
      0n,
      { runtimeHours: 1, cpuCoreHours: 1, memGbHours: 2 },
    ],
    [
      "no allowance, one hour each",
      { runtimeSec: 3600, cpuCoreSec: 3600, memGbSec: 3600 },
      zero,
      750_000n,
      zero,
    ],
    ["zero usage", { runtimeSec: 0, cpuCoreSec: 0, memGbSec: 0 }, zero, 0n, zero],
  ];
  it.each(rows)("%s", (_n, usage, allowance, charge, consumed) => {
    const r = computeCharge(usage, prices, allowance);
    expect(r.chargeMicro).toBe(charge);
    expect(r.allowanceConsumed).toEqual(consumed);
  });
  it("rounds half up", () => {
    const half: Prices = { runtimePerHour: 1n, cpuCorePerHour: 0n, memGbPerHour: 0n };
    expect(
      computeCharge({ runtimeSec: 1800, cpuCoreSec: 0, memGbSec: 0 }, half, zero).chargeMicro,
    ).toBe(1n);
    expect(
      computeCharge({ runtimeSec: 1799, cpuCoreSec: 0, memGbSec: 0 }, half, zero).chargeMicro,
    ).toBe(0n);
  });
  it("negative remaining allowance is treated as zero", () => {
    const r = computeCharge({ runtimeSec: 3600, cpuCoreSec: 0, memGbSec: 0 }, prices, {
      runtimeHours: -5,
      cpuCoreHours: 0,
      memGbHours: 0,
    });
    expect(r.chargeMicro).toBe(500_000n);
    expect(r.allowanceConsumed.runtimeHours).toBe(0);
  });
});

const TZ = "Asia/Ho_Chi_Minh";

describe("local day (Asia/Ho_Chi_Minh, UTC+7)", () => {
  const rows: [string, string, string, string, string][] = [
    [
      "midday",
      "2026-03-10T05:00:00Z",
      "2026-03-10T00:00:00+07:00",
      "2026-03-11T00:00:00+07:00",
      "2026-03-10",
    ],
    [
      "one second before local midnight",
      "2026-03-10T16:59:59Z",
      "2026-03-10T00:00:00+07:00",
      "2026-03-11T00:00:00+07:00",
      "2026-03-10",
    ],
    [
      "exactly local midnight",
      "2026-03-10T17:00:00Z",
      "2026-03-11T00:00:00+07:00",
      "2026-03-12T00:00:00+07:00",
      "2026-03-11",
    ],
    [
      "UTC date differs from local date",
      "2026-03-10T20:30:00Z",
      "2026-03-11T00:00:00+07:00",
      "2026-03-12T00:00:00+07:00",
      "2026-03-11",
    ],
    [
      "fractional milliseconds",
      "2026-03-10T05:00:00.789Z",
      "2026-03-10T00:00:00+07:00",
      "2026-03-11T00:00:00+07:00",
      "2026-03-10",
    ],
    [
      "year rollover",
      "2026-12-31T18:00:00Z",
      "2027-01-01T00:00:00+07:00",
      "2027-01-02T00:00:00+07:00",
      "2027-01-01",
    ],
  ];
  it.each(rows)("%s", (_n, now, start, next, date) => {
    const d = new Date(now);
    expect(localDayStart(d, TZ).toISOString()).toBe(new Date(start).toISOString());
    expect(nextLocalDayStart(d, TZ).toISOString()).toBe(new Date(next).toISOString());
    expect(localDateString(d, TZ)).toBe(date);
  });
  it("handles a DST zone (America/New_York spring forward)", () => {
    const now = new Date("2026-03-08T18:00:00Z"); // 14:00 EDT, the day has 23 hours
    expect(localDayStart(now, "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(nextLocalDayStart(now, "America/New_York").toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });
  it("defaults to Asia/Ho_Chi_Minh", () => {
    expect(localDateString(new Date("2026-03-10T20:30:00Z"))).toBe("2026-03-11");
  });
});

describe("planGate", () => {
  const free = {
    kind: "free" as const,
    dailyRuntimeHours: 6,
    allowanceRuntimeHours: 30,
    allowanceCpuCoreHours: 30,
    allowanceMemGbHours: 60,
  };
  const pro = {
    kind: "package" as const,
    dailyRuntimeHours: null,
    allowanceRuntimeHours: 200,
    allowanceCpuCoreHours: 400,
    allowanceMemGbHours: 800,
  };
  const credits = {
    kind: "payg" as const,
    dailyRuntimeHours: null,
    allowanceRuntimeHours: 0,
    allowanceCpuCoreHours: 0,
    allowanceMemGbHours: 0,
  };
  const noUse = {
    trialEndsAt: null,
    dayStart: null,
    usedTodayRuntimeHours: 0,
    usedRuntimeHours: 0,
    usedCpuCoreHours: 0,
    usedMemGbHours: 0,
  };
  const now = new Date("2026-03-10T05:00:00Z"); // 12:00 on 2026-03-10 in UTC+7
  const trialEnd = new Date("2026-03-10T05:00:00Z");
  const gate = (over: Partial<PlanGateInput> & { plan: PlanGateInput["plan"] }) =>
    planGate({ subscription: noUse, balanceMicro: 0n, now, timeZone: TZ, ...over });
  const sub = (o: Partial<PlanGateInput["subscription"]>) => ({ ...noUse, ...o });

  it("free trial: wakes before the trial end, blocked exactly at it and after", () => {
    const before = new Date(trialEnd.getTime() - 1);
    expect(gate({ plan: free, now: before, subscription: sub({ trialEndsAt: trialEnd }) })).toEqual(
      {
        canWake: true,
        reason: null,
      },
    );
    for (const at of [trialEnd, new Date(trialEnd.getTime() + 86_400_000)]) {
      expect(gate({ plan: free, now: at, subscription: sub({ trialEndsAt: trialEnd }) })).toEqual({
        canWake: false,
        reason: "trial_ended",
      });
    }
  });
  it("free trial: credits never help (no credits during the trial)", () => {
    expect(
      gate({
        plan: free,
        balanceMicro: 999_000_000n,
        subscription: sub({ trialEndsAt: trialEnd }),
      }).reason,
    ).toBe("trial_ended");
    expect(
      gate({
        plan: free,
        balanceMicro: 999_000_000n,
        subscription: sub({ usedRuntimeHours: 30 }),
      }).reason,
    ).toBe("credits_exhausted");
  });
  it("free without a trial end never expires", () => {
    expect(gate({ plan: free, now: new Date("2030-01-01T00:00:00Z") }).canWake).toBe(true);
  });
  it("daily cap: 5.999 h still wakes, exactly 6 h blocks with resume at next local midnight", () => {
    const day = "2026-03-10";
    expect(
      gate({ plan: free, subscription: sub({ dayStart: day, usedTodayRuntimeHours: 5.999 }) }),
    ).toEqual({ canWake: true, reason: null });
    const blocked = gate({
      plan: free,
      subscription: sub({ dayStart: day, usedTodayRuntimeHours: 6 }),
    });
    expect(blocked.canWake).toBe(false);
    expect(blocked.reason).toBe("daily_limit");
    expect(blocked.resumesAt?.toISOString()).toBe("2026-03-10T17:00:00.000Z"); // 00:00 on the 11th, UTC+7
  });
  it("daily counter resets at local midnight (UTC+7), not at UTC midnight", () => {
    const used = sub({ dayStart: "2026-03-10", usedTodayRuntimeHours: 6 });
    // 16:59:59Z = 23:59:59 local: still the 10th -> blocked
    expect(
      gate({ plan: free, now: new Date("2026-03-10T16:59:59Z"), subscription: used }).reason,
    ).toBe("daily_limit");
    // 17:00:00Z = 00:00 local on the 11th -> stale counter ignored
    expect(gate({ plan: free, now: new Date("2026-03-10T17:00:00Z"), subscription: used })).toEqual(
      {
        canWake: true,
        reason: null,
      },
    );
    // 00:00Z the same UTC day is already 07:00 local on the 10th: counter still applies
    expect(
      gate({ plan: free, now: new Date("2026-03-10T00:00:00Z"), subscription: used }).reason,
    ).toBe("daily_limit");
  });
  it("trial end wins over the daily cap", () => {
    expect(
      gate({
        plan: free,
        subscription: sub({
          trialEndsAt: trialEnd,
          dayStart: "2026-03-10",
          usedTodayRuntimeHours: 6,
        }),
      }).reason,
    ).toBe("trial_ended");
  });
  it("runtimeUsedToday ignores a counter from another local day", () => {
    expect(runtimeUsedToday({ dayStart: "2026-03-09", usedTodayRuntimeHours: 4 }, now, TZ)).toBe(0);
    expect(runtimeUsedToday({ dayStart: null, usedTodayRuntimeHours: 4 }, now, TZ)).toBe(0);
    expect(runtimeUsedToday({ dayStart: "2026-03-10", usedTodayRuntimeHours: 4 }, now, TZ)).toBe(4);
  });
  it("package: allowance or credits wake; neither blocks; no daily cap", () => {
    expect(gate({ plan: pro }).canWake).toBe(true);
    expect(
      gate({ plan: pro, subscription: sub({ usedRuntimeHours: 200 }), balanceMicro: 1n }).canWake,
    ).toBe(true);
    expect(gate({ plan: pro, subscription: sub({ usedRuntimeHours: 200 }) })).toEqual({
      canWake: false,
      reason: "credits_exhausted",
    });
    expect(
      gate({ plan: pro, subscription: sub({ usedMemGbHours: 800 }), balanceMicro: -5n }).reason,
    ).toBe("credits_exhausted");
    expect(
      gate({ plan: pro, subscription: sub({ usedTodayRuntimeHours: 20, dayStart: "2026-03-10" }) })
        .canWake,
    ).toBe(true);
  });
  it("credits only: needs a positive balance", () => {
    expect(gate({ plan: credits, balanceMicro: 1n })).toEqual({ canWake: true, reason: null });
    for (const b of [0n, -5n]) {
      expect(gate({ plan: credits, balanceMicro: b })).toEqual({
        canWake: false,
        reason: "credits_exhausted",
      });
    }
  });
});
