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

export const BILLING_TIME_ZONE = "Asia/Ho_Chi_Minh";
/** Fixed ids of the seeded plans (see migration 0004). */
export const FREE_PLAN_ID = "00000000-0000-4000-8000-0000000000a1";
export const CREDITS_ONLY_PLAN_ID = "00000000-0000-4000-8000-0000000000a2";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function zoneParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return {
    y: n("year"),
    mo: n("month"),
    d: n("day"),
    h: n("hour"),
    mi: n("minute"),
    s: n("second"),
  };
}

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = zoneParts(at, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Calendar date (`YYYY-MM-DD`) of `now` in `timeZone`; matches a Postgres `date` column. */
export function localDateString(now: Date, timeZone: string = BILLING_TIME_ZONE): string {
  const p = zoneParts(now, timeZone);
  return `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** The instant of 00:00 `timeZone` on the local day containing `now`. */
export function localDayStart(now: Date, timeZone: string = BILLING_TIME_ZONE): Date {
  const p = zoneParts(now, timeZone);
  const wallMidnight = Date.UTC(p.y, p.mo - 1, p.d);
  // Two passes so a DST change between midnight and `now` resolves to the right offset.
  let guess = wallMidnight - zoneOffsetMs(now, timeZone);
  guess = wallMidnight - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The instant of the next 00:00 `timeZone` strictly after `now`. */
export function nextLocalDayStart(now: Date, timeZone: string = BILLING_TIME_ZONE): Date {
  const start = localDayStart(now, timeZone);
  // 25h from local midnight always lands inside the next local day (even across DST).
  return localDayStart(new Date(start.getTime() + DAY_MS + HOUR_MS), timeZone);
}

export type WakeBlockReason = "trial_ended" | "daily_limit" | "credits_exhausted";
export interface PlanGateResult {
  canWake: boolean;
  reason: WakeBlockReason | null;
  /** Only for `daily_limit`: when waking becomes possible again. */
  resumesAt?: Date;
}
export interface PlanGateInput {
  plan: {
    kind: PlanKind;
    dailyRuntimeHours: number | null;
    allowanceRuntimeHours: number;
    allowanceCpuCoreHours: number;
    allowanceMemGbHours: number;
  };
  subscription: {
    trialEndsAt: Date | null;
    /** Local date (`YYYY-MM-DD`) that `usedTodayRuntimeHours` was counted for. */
    dayStart: string | null;
    usedTodayRuntimeHours: number;
    usedRuntimeHours: number;
    usedCpuCoreHours: number;
    usedMemGbHours: number;
  };
  balanceMicro: bigint;
  now: Date;
  timeZone: string;
}

/** Runtime used on the local day of `now` (a stale `dayStart` means a new day: 0). */
export function runtimeUsedToday(
  sub: { dayStart: string | null; usedTodayRuntimeHours: number },
  now: Date,
  timeZone: string = BILLING_TIME_ZONE,
): number {
  return sub.dayStart === localDateString(now, timeZone) ? sub.usedTodayRuntimeHours : 0;
}

/**
 * Whether a workspace may run (wake or keep running) right now.
 * Free: trial end, then the daily runtime cap, then the included runtime (no credits during the trial).
 * Other plans: any included allowance left, or a positive credit balance ("Credits only" has no allowance).
 */
export function planGate(input: PlanGateInput): PlanGateResult {
  const { plan, subscription: sub, balanceMicro, now, timeZone } = input;
  const blocked = (reason: WakeBlockReason, resumesAt?: Date): PlanGateResult =>
    resumesAt ? { canWake: false, reason, resumesAt } : { canWake: false, reason };

  const allowanceLeft =
    plan.allowanceRuntimeHours - sub.usedRuntimeHours > 0 &&
    plan.allowanceCpuCoreHours - sub.usedCpuCoreHours > 0 &&
    plan.allowanceMemGbHours - sub.usedMemGbHours > 0;

  if (plan.kind === "free") {
    if (sub.trialEndsAt && now.getTime() >= sub.trialEndsAt.getTime())
      return blocked("trial_ended");
    if (
      plan.dailyRuntimeHours !== null &&
      runtimeUsedToday(sub, now, timeZone) >= plan.dailyRuntimeHours
    ) {
      return blocked("daily_limit", nextLocalDayStart(now, timeZone));
    }
    return allowanceLeft ? { canWake: true, reason: null } : blocked("credits_exhausted");
  }
  if (balanceMicro > 0n || allowanceLeft) {
    return { canWake: true, reason: null };
  }
  return blocked("credits_exhausted");
}
