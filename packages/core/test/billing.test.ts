import { describe, expect, it } from "vitest";
import { canWake, computeCharge, type Allowance, type Prices } from "../src/billing.ts";

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

describe("canWake", () => {
  const full: Allowance = { runtimeHours: 1, cpuCoreHours: 1, memGbHours: 1 };
  const rows: [string, bigint, Allowance, boolean][] = [
    ["balance 0 and one exhausted allowance", 0n, { ...full, cpuCoreHours: 0 }, false],
    ["balance 0, all exhausted", 0n, zero, false],
    ["balance 0, all allowances positive", 0n, full, true],
    ["positive balance, no allowance", 1n, zero, true],
    ["negative balance, no allowance", -5n, zero, false],
    ["negative balance, full allowance", -5n, full, true],
  ];
  it.each(rows)("%s", (_n, balanceMicro, allowanceRemaining, expected) => {
    for (const planKind of ["free", "package", "payg"] as const) {
      expect(canWake({ balanceMicro, allowanceRemaining, planKind })).toBe(expected);
    }
  });
});
