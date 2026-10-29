import { lstat, readdir, readFile, statfs } from "node:fs/promises";
import { cpus, loadavg, release, uptime } from "node:os";
import { wsSlugSchema, type StatsResponse } from "@agentbox/core/agent-api";
import { parseMeminfo, readCgroupStats, type CgroupStats } from "./cgroup.ts";
import { CP_USER, MANAGED_IP_FILE, STORAGE_MOUNT, TENANTS_DIR } from "./config.ts";
import { parseNftCounters, parseXfsQuotaReport } from "./diagnostics.ts";
import { run } from "./exec.ts";
import { errMessage, logEvent } from "./log.ts";
import { isTenantUid, slotOfUid } from "./safe.ts";
import { parseSs, TrafficTracker, type TenantNet } from "./ss.ts";
import { registry, type RunningWorkspace } from "./state.ts";
import { containerRunning, inspectContainer } from "./workspaces.ts";

const tracker = new TrafficTracker();

let podmanVersion: string | null | undefined;
async function readPodmanVersion(): Promise<string | null> {
  if (podmanVersion !== undefined) return podmanVersion;
  const r = await run("podman", ["--version"], { check: false, timeoutMs: 10_000 }).catch(
    () => null,
  );
  const v = r && r.code === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
  if (v !== null) podmanVersion = v;
  return v;
}

async function serviceStates(): Promise<{ name: string; active: boolean }[]> {
  const cp = await run("id", ["-u", CP_USER], { check: false });
  const names = ["agentbox-agent", "agentbox-storage", "agentbox-firewall"];
  if (cp.code === 0) names.push(`user@${cp.stdout.trim()}`);
  // `is-active` prints one state per unit (in order) and exits non-zero when any is not active.
  const r = await run("systemctl", ["is-active", ...names.map((n) => `${n}.service`)], {
    check: false,
    timeoutMs: 10_000,
  });
  const states = r.stdout.trim().split("\n");
  return names.map((name, i) => ({ name, active: states[i] === "active" }));
}

async function firewallStats(): Promise<StatsResponse["host"]["firewall"]> {
  const r = await run("nft", ["list", "chain", "inet", "agentbox", "output"], {
    check: false,
    timeoutMs: 10_000,
  });
  return parseNftCounters(r.code === 0 ? r.stdout : "");
}

async function tenantStats(): Promise<StatsResponse["tenants"]> {
  const [names, report] = await Promise.all([
    readdir(TENANTS_DIR).catch(() => [] as string[]),
    run("xfs_quota", ["-x", "-c", "report -u -n -N -b -i", STORAGE_MOUNT], {
      check: false,
      timeoutMs: 20_000,
    }),
  ]);
  const quota = parseXfsQuotaReport(report.code === 0 ? report.stdout : "");
  const out: StatsResponse["tenants"] = [];
  for (const ws of names) {
    if (!wsSlugSchema.safeParse(ws).success) continue;
    const st = await lstat(`${TENANTS_DIR}/${ws}`).catch(() => null);
    if (!st || !isTenantUid(st.uid)) continue;
    const q = quota.get(st.uid);
    out.push({
      ws,
      uid: st.uid,
      diskUsedBytes: q?.diskUsedBytes ?? 0,
      diskLimitBytes: q?.diskLimitBytes ?? 0,
      inodesUsed: q?.inodesUsed ?? 0,
      inodesLimit: q?.inodesLimit ?? 0,
    });
  }
  return out;
}

async function hostStats(): Promise<StatsResponse["host"]> {
  const mem = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  const fs = await statfs(STORAGE_MOUNT);
  const [a = 0, b = 0, c = 0] = loadavg();
  const [services, firewall, podman, ip] = await Promise.all([
    serviceStates(),
    firewallStats(),
    readPodmanVersion(),
    readFile(MANAGED_IP_FILE, "utf8").catch(() => ""),
  ]);
  return {
    cpus: cpus().length,
    ...mem,
    diskTotalBytes: fs.blocks * fs.bsize,
    diskFreeBytes: fs.bavail * fs.bsize,
    loadavg: [a, b, c],
    uptimeSec: uptime(),
    kernel: release(),
    podmanVersion: podman,
    services,
    firewall,
    publicIpBlocked: ip.trim() || null,
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
  const [host, tenantsOut, ssOut] = await Promise.all([
    hostStats(),
    tenantStats(),
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
        startedAt: w.startedAt,
      };
    }),
  );
  return { host, tenants: tenantsOut, workspaces };
}
