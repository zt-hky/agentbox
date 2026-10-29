import type { ProcessInfo } from "@agentbox/core/agent-api";
import { isTenantUid } from "./safe.ts";

export interface QuotaRow {
  uid: number;
  diskUsedBytes: number;
  diskLimitBytes: number;
  inodesUsed: number;
  inodesLimit: number;
}

/**
 * `xfs_quota -x -c 'report -u -n -N -b -i'`: per user
 * `#uid used(KiB) soft hard warn [grace] inodes soft hard warn [grace]`. Only tenant uids are kept.
 */
export function parseXfsQuotaReport(out: string): Map<number, QuotaRow> {
  const rows = new Map<number, QuotaRow>();
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    const m = /^#(\d+)$/.exec(f[0] ?? "");
    if (!m || f.length < 11) continue;
    const uid = Number(m[1]);
    if (!isTenantUid(uid)) continue;
    const n = (i: number) => Number(f[i]);
    const [used, hard, iused, ihard] = [n(1), n(3), n(6), n(8)];
    if (![used, hard, iused, ihard].every(Number.isFinite)) continue;
    rows.set(uid, {
      uid,
      diskUsedBytes: used * 1024,
      diskLimitBytes: hard * 1024,
      inodesUsed: iused,
      inodesLimit: ihard,
    });
  }
  return rows;
}

/** `podman top <c> -eo pid,user,pcpu,pmem,etime,args`: a header row, then fixed columns + the command line. */
export function parsePodmanTop(out: string, maxProcesses = 500): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of out.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    processes.push({
      pid: Number(m[1]),
      user: m[2] as string,
      cpu: Number(m[3]),
      mem: Number(m[4]),
      elapsed: m[5] as string,
      command: (m[6] as string).slice(0, 500),
    });
    if (processes.length >= maxProcesses) break;
  }
  return processes;
}

export interface FirewallCounters {
  blockedPackets: number;
  smtpPackets: number;
  ipv6Packets: number;
}

/** Packet counters of the drop rules in `nft list chain inet agentbox output`. */
export function parseNftCounters(out: string): FirewallCounters {
  const c: FirewallCounters = { blockedPackets: 0, smtpPackets: 0, ipv6Packets: 0 };
  for (const line of out.split("\n")) {
    const m = /counter packets (\d+) bytes \d+ drop/.exec(line);
    if (!m) continue;
    const packets = Number(m[1]);
    if (/@(?:extra_)?blocked4/.test(line)) c.blockedPackets += packets;
    else if (/tcp dport 25\b/.test(line)) c.smtpPackets += packets;
    else if (/nfproto ipv6/.test(line)) c.ipv6Packets += packets;
  }
  return c;
}

/** `podman logs -t` writes the container's stdout and stderr to different streams; interleave by timestamp. */
export function mergeLogStreams(stdout: string, stderr: string, tail: number): string {
  const lines = [...stdout.split("\n"), ...stderr.split("\n")]
    .filter((l) => l !== "")
    .map((l, i) => ({ l, i, ts: l.slice(0, l.indexOf(" ") === -1 ? 0 : l.indexOf(" ")) }));
  lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i));
  return lines
    .slice(-tail)
    .map((x) => x.l)
    .join("\n");
}

/** `2026-10-29 10:05:59.909191158 +0000 UTC` (Go time.String) → ISO, or null. */
export function parsePodmanTime(s: string): string | null {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))? ([+-]\d\d)(\d\d)/.exec(s.trim());
  if (!m) return null;
  const ms = (m[3] ?? "0").padEnd(3, "0").slice(0, 3);
  const d = new Date(`${m[1]}T${m[2]}.${ms}${m[4]}:${m[5]}`);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 ? null : d.toISOString();
}
