import {
  BILLING_TIME_ZONE,
  planGate,
  runtimeUsedToday,
  type PlanGateResult,
} from "@agentbox/core/billing";
import { formatDuration } from "./format";

export interface PlanStatusPlan {
  kind: "free" | "package" | "payg";
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
  dailyRuntimeHours: number | null;
}

export interface PlanStatusSub {
  trialEndsAt: Date | null;
  dayStart: string | null;
  usedTodayRuntimeHours: number;
  usedRuntimeHours: number;
  usedCpuCoreHours: number;
  usedMemGbHours: number;
}

export interface PlanStatus {
  /** "3 days left", "5 h 10 min left", "Trial ended"; null when the plan has no trial. */
  trialText: string | null;
  /** "4 h 10 min left today"; null without a daily cap. */
  dailyText: string | null;
  /** Runtime used on the local day; null without a daily cap. */
  usedTodayHours: number | null;
  /** Included runtime still available this cycle, in hours; null when the plan includes none. */
  runtimeLeftHours: number | null;
  gate: PlanGateResult;
}

/** Time left in a trial: whole days while >= 1 day remains, else hours and minutes. */
export function trialLeftText(now: Date, endsAt: Date): string {
  const sec = Math.floor((endsAt.getTime() - now.getTime()) / 1000);
  if (sec <= 0) return "Trial ended";
  const days = Math.floor(sec / 86400);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"} left`;
  return `${formatDuration(sec)} left`;
}

/** Everything a plan card needs to say about trial, daily cap and included runtime. */
export function planStatus(input: {
  plan: PlanStatusPlan;
  sub: PlanStatusSub;
  balanceMicro: bigint;
  now: Date;
}): PlanStatus {
  const { plan, sub, balanceMicro, now } = input;
  const trialText =
    plan.kind === "free" && sub.trialEndsAt ? trialLeftText(now, sub.trialEndsAt) : null;
  const usedTodayHours =
    plan.dailyRuntimeHours === null ? null : runtimeUsedToday(sub, now, BILLING_TIME_ZONE);
  const dailyText =
    plan.dailyRuntimeHours === null || usedTodayHours === null
      ? null
      : `${formatDuration(Math.max(0, plan.dailyRuntimeHours - usedTodayHours) * 3600)} left today`;
  const runtimeLeftHours =
    plan.allowanceRuntimeHours > 0
      ? Math.max(0, plan.allowanceRuntimeHours - sub.usedRuntimeHours)
      : null;
  const gate = planGate({
    plan,
    subscription: sub,
    balanceMicro,
    now,
    timeZone: BILLING_TIME_ZONE,
  });
  return { trialText, dailyText, usedTodayHours, runtimeLeftHours, gate };
}

/** User-facing sentence for why the workspace cannot wake; null when it can. */
export function gateMessage(
  gate: PlanGateResult,
  plan: Pick<PlanStatusPlan, "dailyRuntimeHours">,
): string | null {
  switch (gate.reason) {
    case null:
      return null;
    case "trial_ended":
      return "Your trial has ended. Ask an admin to upgrade, or add credits to keep running.";
    case "daily_limit":
      return `Today's ${plan.dailyRuntimeHours ?? 0} hours are used. Back at 00:00 (Vietnam time), or ask an admin to upgrade.`;
    case "credits_exhausted":
      return "No included runtime or credits left. Ask an admin to add credits or upgrade.";
  }
}
