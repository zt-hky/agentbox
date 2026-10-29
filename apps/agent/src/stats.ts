import { readFile, statfs } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import type { StatsResponse } from "@agentbox/core/agent-api";
import { parseMeminfo, readCgroupStats, type CgroupStats } from "./cgroup.ts";
import { STORAGE_MOUNT } from "./config.ts";
import { run } from "./exec.ts";
import { errMessage, logEvent } from "./log.ts";
import { slotOfUid } from "./safe.ts";
import { parseSs, TrafficTracker, type TenantNet } from "./ss.ts";
import { registry, type RunningWorkspace } from "./state.ts";
import { containerRunning, inspectContainer } from "./workspaces.ts";

const tracker = new TrafficTracker();

async function hostStats(): Promise<StatsResponse["host"]> {
  const mem = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  const fs = await statfs(STORAGE_MOUNT);
  const [a = 0, b = 0, c = 0] = loadavg();
  return {
    cpus: cpus().length,
    ...mem,
    diskTotalBytes: fs.blocks * fs.bsize,
    diskFreeBytes: fs.bavail * fs.bsize,
    loadavg: [a, b, c],
  };
}

const ZERO: CgroupStats = { cpuUsageUsec: 0, memoryCurrent: 0, oomKills: 0, pidsCurrent: 0 };

async function workspaceStats(w: RunningWorkspace): Promise<CgroupStats | null> {
  try {
    return await readCgroupStats(w.cgroupPath);
  } catch {
    /* cgroup gone or moved: ask podman, only now */
  }
  if (!(await containerRunning(w.ws, w.uid))) return null;
  try {
    const info = await inspectContainer(w.ws);
    w.cgroupPath = info.cgroupPath;
    return await readCgroupStats(w.cgroupPath);
  } catch (e) {
    logEvent({ ws: w.ws, event: "stats_failed", error: errMessage(e) });
    return null;
  }
}

export async function collectStats(): Promise<StatsResponse> {
  const entries = [...registry.values()];
  const tenants = new Map<number, TenantNet>();
  for (const w of entries) {
    tenants.set(w.uid, {
      ws: w.ws,
      ports: [20000 + 2 * slotOfUid(w.uid), 20001 + 2 * slotOfUid(w.uid)],
    });
  }
  const [host, ssOut] = await Promise.all([
    hostStats(),
    run("ss", ["-Htine", "state", "established"], {
      maxBytes: 128 * 1024 * 1024,
      timeoutMs: 20_000,
      check: false,
    }),
  ]);
  const traffic = tracker.update(ssOut.code === 0 ? parseSs(ssOut.stdout) : [], tenants);
  const workspaces = await Promise.all(
    entries.map(async (w) => {
      const cg = await workspaceStats(w);
      if (cg === null) registry.delete(w.ws);
      const t = traffic.get(w.ws);
      return {
        ws: w.ws,
        ...(cg ?? ZERO),
        gatewayBytesDelta: t?.gatewayBytes ?? 0,
        egressBytesDelta: t?.egressBytes ?? 0,
        running: cg !== null,
      };
    }),
  );
  return { host, workspaces };
}
