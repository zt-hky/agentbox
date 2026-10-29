import { run } from "./exec.ts";

const SHUTDOWN_TARGETS = /\b(?:shutdown|reboot|poweroff|halt|kexec)\.target\b/;

/** True when `systemctl is-system-running` says `stopping` or a shutdown-type target has a pending job. */
export function isHostShuttingDown(isSystemRunning: string, listJobs: string): boolean {
  if (isSystemRunning.trim() === "stopping") return true;
  return listJobs.split("\n").some((l) => SHUTDOWN_TARGETS.test(l) && /\bstart\b/.test(l));
}

export async function hostIsShuttingDown(): Promise<boolean> {
  const [state, jobs] = await Promise.all([
    run("systemctl", ["is-system-running"], { check: false, timeoutMs: 5000 }).catch(() => null),
    run("systemctl", ["list-jobs", "--no-pager"], { check: false, timeoutMs: 5000 }).catch(
      () => null,
    ),
  ]);
  return isHostShuttingDown(state?.stdout ?? "", jobs?.stdout ?? "");
}
