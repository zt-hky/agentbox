import { MICRO_PER_CREDIT } from "@agentbox/core/billing";
import { UserError } from "./errors";

/** micro-credits -> "12.5" style decimal string (2..6 fraction digits, trailing zeros trimmed past 2). */
export function microToCredits(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_CREDIT;
  let frac = (abs % MICRO_PER_CREDIT).toString().padStart(6, "0");
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

/** "1.50" -> "1.5", "139.00" -> "139" (display only). */
function trimCredits(micro: bigint): string {
  return microToCredits(micro)
    .replace(/\.00$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

const VND = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

/** Whole dong with vi-VN grouping: 139000 -> "139.000 ₫". */
export function formatVnd(amount: number): string {
  return `${VND.format(Math.round(amount))} ₫`;
}

/** VND equivalent of a credit amount (1 credit = `creditValueVnd` dong). */
export function creditsToVnd(micro: bigint, creditValueVnd: number): number {
  return (Number(micro) * creditValueVnd) / Number(MICRO_PER_CREDIT);
}

/**
 * "139 credits (139.000 ₫)". Without `creditValueVnd` only the credit amount is shown.
 * The label is pluralized by appending "s" unless the amount is exactly 1.
 */
export function formatCredits(micro: bigint, label: string, creditValueVnd?: number): string {
  const abs = micro < 0n ? -micro : micro;
  const name = abs === MICRO_PER_CREDIT ? label : `${label}s`;
  const base = `${trimCredits(micro)} ${name}`;
  return creditValueVnd === undefined
    ? base
    : `${base} (${formatVnd(creditsToVnd(micro, creditValueVnd))})`;
}

/** Decimal credit amount ("1.25") -> micro-credits. */
export function creditsToMicro(input: string, opts: { allowZero?: boolean } = {}): bigint {
  const s = input.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new UserError("Enter a decimal amount with at most 6 fraction digits");
  const micro = BigInt(m[1]!) * MICRO_PER_CREDIT + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (micro === 0n && !opts.allowZero) throw new UserError("Amount must be greater than zero");
  return micro;
}
