/** Parsing of `ss -Htine state established` and per-inode delta accounting. */

export interface SsSocket {
  inode: number;
  uid: number | null;
  localHost: string;
  localPort: number;
  peerHost: string;
  peerPort: number;
  /** bytes_acked + bytes_received (cumulative for the socket). */
  bytes: number;
}

export function splitAddr(addr: string): { host: string; port: number } | null {
  const i = addr.lastIndexOf(":");
  if (i <= 0) return null;
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  let host = addr.slice(0, i);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host, port };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/%.*$/, "");
  return h === "::1" || h.startsWith("127.") || h.startsWith("::ffff:127.");
}

/** A record is a non-indented line followed by indented continuation lines. */
export function parseSs(text: string): SsSocket[] {
  const records: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (/^\s/.test(line) && records.length > 0) records[records.length - 1] += ` ${line.trim()}`;
    else records.push(line.trim());
  }
  const out: SsSocket[] = [];
  for (const rec of records) {
    const f = rec.split(/\s+/);
    const local = f[2] ? splitAddr(f[2]) : null;
    const peer = f[3] ? splitAddr(f[3]) : null;
    const ino = /\bino:(\d+)/.exec(rec);
    if (!local || !peer || !ino) continue;
    const uid = /\buid:(\d+)/.exec(rec);
    const acked = /\bbytes_acked:(\d+)/.exec(rec);
    const received = /\bbytes_received:(\d+)/.exec(rec);
    out.push({
      inode: Number(ino[1]),
      uid: uid ? Number(uid[1]) : null,
      localHost: local.host,
      localPort: local.port,
      peerHost: peer.host,
      peerPort: peer.port,
      bytes: Number(acked?.[1] ?? 0) + Number(received?.[1] ?? 0),
    });
  }
  return out;
}

export interface TenantNet {
  ws: string;
  ports: readonly number[];
}

export interface TrafficDelta {
  gatewayBytes: number;
  egressBytes: number;
}

/**
 * Single-consumer delta tracker. `gateway` = sockets whose local side is 127.0.0.1:<tenant port>;
 * `egress` = tenant-UID sockets with a non-loopback peer. A socket first seen contributes its whole
 * counter (it opened since the previous call); a socket that vanished is dropped.
 */
export class TrafficTracker {
  private prev = new Map<number, number>();

  update(
    sockets: readonly SsSocket[],
    tenantsByUid: ReadonlyMap<number, TenantNet>,
  ): Map<string, TrafficDelta> {
    const portToWs = new Map<number, string>();
    for (const t of tenantsByUid.values()) for (const p of t.ports) portToWs.set(p, t.ws);
    const next = new Map<number, number>();
    const out = new Map<string, TrafficDelta>();
    const slot = (ws: string): TrafficDelta => {
      let d = out.get(ws);
      if (!d) out.set(ws, (d = { gatewayBytes: 0, egressBytes: 0 }));
      return d;
    };
    for (const s of sockets) {
      let kind: "gateway" | "egress" | null = null;
      let ws: string | undefined;
      if (isLoopbackHost(s.localHost) && portToWs.has(s.localPort)) {
        kind = "gateway";
        ws = portToWs.get(s.localPort);
      } else if (s.uid !== null && tenantsByUid.has(s.uid) && !isLoopbackHost(s.peerHost)) {
        kind = "egress";
        ws = tenantsByUid.get(s.uid)?.ws;
      }
      if (kind === null || ws === undefined) continue;
      const before = this.prev.get(s.inode);
      const delta = before === undefined || s.bytes < before ? s.bytes : s.bytes - before;
      next.set(s.inode, s.bytes);
      const d = slot(ws);
      if (kind === "gateway") d.gatewayBytes += delta;
      else d.egressBytes += delta;
    }
    this.prev = next;
    return out;
  }
}
