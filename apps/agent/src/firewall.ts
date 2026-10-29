import { readFile, writeFile } from "node:fs/promises";
import { EXTRA_BLOCKED_CONF, FIREWALL_SYNC_MS, MANAGED_IP_FILE, PUBLIC_IP_URL } from "./config.ts";
import { run } from "./exec.ts";
import { errMessage, logEvent } from "./log.ts";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const CIDR4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/(?:3[0-2]|[12]?\d))?$/;

export function parseTraceIp(trace: string): string | null {
  const m = /^ip=(.+)$/m.exec(trace);
  const ip = m?.[1]?.trim();
  return ip && IPV4.test(ip) ? ip : null;
}

export function parseExtraBlocked(conf: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of conf.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    (CIDR4.test(line) ? valid : invalid).push(line);
  }
  return { valid, invalid };
}

const nftElement = (verb: "add" | "delete", el: string[]) =>
  run("nft", [verb, "element", "inet", "agentbox", "extra_blocked4", `{ ${el.join(", ")} }`], {
    check: false,
  });

export async function loadExtraBlocked(): Promise<void> {
  const conf = await readFile(EXTRA_BLOCKED_CONF, "utf8").catch(() => "");
  const { valid, invalid } = parseExtraBlocked(conf);
  if (invalid.length) logEvent({ event: "extra_blocked_invalid_lines", count: invalid.length });
  for (const cidr of valid) {
    const r = await nftElement("add", [cidr]);
    if (r.code !== 0) logEvent({ event: "extra_blocked_add_failed", exitCode: r.code });
  }
  logEvent({ event: "extra_blocked_loaded", count: valid.length });
}

let managedIp: string | null = null;
/** False until this process has added the element once (the table may have been recreated). */
let verified = false;

export async function syncPublicIp(): Promise<void> {
  try {
    const res = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(10_000) });
    const ip = parseTraceIp(await res.text());
    if (!ip) throw new Error("no ipv4 in trace response");
    if (ip === managedIp && verified) return;
    const old = managedIp;
    if (old && old !== ip) await nftElement("delete", [old]);
    const r = await nftElement("add", [ip]);
    if (r.code !== 0)
      throw new Error(`nft add element failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    managedIp = ip;
    verified = true;
    await writeFile(MANAGED_IP_FILE, `${ip}\n`, { mode: 0o644 });
    logEvent({ event: "public_ip_blocked", replaced: old !== null && old !== ip });
  } catch (e) {
    logEvent({ event: "public_ip_sync_failed", error: errMessage(e) });
  }
}

export async function startFirewallSync(): Promise<() => void> {
  // A previous run's element stays in the live set; remember it so it is replaced, not leaked.
  const prev = (await readFile(MANAGED_IP_FILE, "utf8").catch(() => "")).trim();
  if (IPV4.test(prev)) managedIp = prev;
  await loadExtraBlocked().catch((e) =>
    logEvent({ event: "extra_blocked_failed", error: errMessage(e) }),
  );
  await syncPublicIp();
  const timer = setInterval(() => void syncPublicIp(), FIREWALL_SYNC_MS);
  timer.unref();
  return () => clearInterval(timer);
}
