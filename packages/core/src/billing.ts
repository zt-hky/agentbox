export const MICRO_PER_CREDIT = 1_000_000n;

export interface Usage {
  runtimeSec: number;
  cpuCoreSec: number;
  memGbSec: number;
}
export interface Prices {
  runtimePerHour: bigint;
  cpuCorePerHour: bigint;
  memGbPerHour: bigint;
}
export interface Allowance {
  runtimeHours: number;
  cpuCoreHours: number;
  memGbHours: number;
}
export type PlanKind = "free" | "package" | "payg";

/** Allowance consumed by a sample (in hours) and the charge in micro-credits. */
export function computeCharge(
  usage: Usage,
  prices: Prices,
  allowanceRemaining: Allowance,
): { allowanceConsumed: Allowance; chargeMicro: bigint } {
  const units = [
    [usage.runtimeSec / 3600, allowanceRemaining.runtimeHours, prices.runtimePerHour],
    [usage.cpuCoreSec / 3600, allowanceRemaining.cpuCoreHours, prices.cpuCorePerHour],
    [usage.memGbSec / 3600, allowanceRemaining.memGbHours, prices.memGbPerHour],
  ] as const;
  const consumed: number[] = [];
  let total = 0;
  for (const [hours, remaining, price] of units) {
    const h = Math.max(0, hours);
    const used = Math.min(h, Math.max(0, remaining));
    consumed.push(used);
    total += (h - used) * Number(price);
  }
  return {
    allowanceConsumed: {
      runtimeHours: consumed[0]!,
      cpuCoreHours: consumed[1]!,
      memGbHours: consumed[2]!,
    },
    chargeMicro: BigInt(Math.floor(total + 0.5)),
  };
}

export function canWake(input: {
  balanceMicro: bigint;
  allowanceRemaining: Allowance;
  planKind: PlanKind;
}): boolean {
  const a = input.allowanceRemaining;
  return input.balanceMicro > 0n || (a.runtimeHours > 0 && a.cpuCoreHours > 0 && a.memGbHours > 0);
}
