export interface IdleConfig {
  idleTimeoutMinutes: number;
  idleCpuPercent: number;
  idleNetBytesPerMin: number;
  maxAwakeHours: number;
}

export interface ActivityInput {
  now: Date;
  lastActivityAt: Date;
  lastRequestAt: Date | null;
  cpuPercent: number;
  netBytesPerMin: number;
  awakeSince: Date;
  config: IdleConfig;
}

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export function evaluateActivity(i: ActivityInput): {
  active: boolean;
  stopReason: "idle" | "max_awake" | null;
} {
  const nowMs = i.now.getTime();
  const c = i.config;
  const active =
    (i.lastRequestAt !== null &&
      nowMs - i.lastRequestAt.getTime() < c.idleTimeoutMinutes * MIN_MS) ||
    i.cpuPercent >= c.idleCpuPercent ||
    i.netBytesPerMin >= c.idleNetBytesPerMin;
  if (c.maxAwakeHours > 0 && nowMs - i.awakeSince.getTime() >= c.maxAwakeHours * HOUR_MS) {
    return { active, stopReason: "max_awake" };
  }
  if (!active && nowMs - i.lastActivityAt.getTime() >= c.idleTimeoutMinutes * MIN_MS) {
    return { active, stopReason: "idle" };
  }
  return { active, stopReason: null };
}
