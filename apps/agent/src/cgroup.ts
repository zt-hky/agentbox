import { readFile } from "node:fs/promises";
import { isSafeCgroupPath } from "./safe.ts";

/** Value of `key` in a flat-keyed cgroup file ("usage_usec 123"). */
export function parseKeyed(text: string, key: string): number | null {
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k === key && v !== undefined && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

/** Single-integer file such as memory.current or pids.current. */
export function parseSingle(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

export interface CgroupStats {
  cpuUsageUsec: number;
  memoryCurrent: number;
  oomKills: number;
  pidsCurrent: number;
}

const ROOT = "/sys/fs/cgroup";

/** Throws ENOENT-style errors when the cgroup is gone. */
export async function readCgroupStats(cgroupPath: string): Promise<CgroupStats> {
  if (!isSafeCgroupPath(cgroupPath)) throw new Error("unsafe cgroup path");
  const dir = `${ROOT}${cgroupPath}`;
  const [cpu, mem, ev, pids] = await Promise.all([
    readFile(`${dir}/cpu.stat`, "utf8"),
    readFile(`${dir}/memory.current`, "utf8"),
    readFile(`${dir}/memory.events`, "utf8"),
    readFile(`${dir}/pids.current`, "utf8"),
  ]);
  return {
    cpuUsageUsec: parseKeyed(cpu, "usage_usec") ?? 0,
    memoryCurrent: parseSingle(mem) ?? 0,
    oomKills: parseKeyed(ev, "oom_kill") ?? 0,
    pidsCurrent: parseSingle(pids) ?? 0,
  };
}

export function parseMeminfo(text: string): { memTotalBytes: number; memAvailableBytes: number } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  };
  return { memTotalBytes: kb("MemTotal"), memAvailableBytes: kb("MemAvailable") };
}
