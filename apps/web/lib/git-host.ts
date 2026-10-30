import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(addr: string): boolean {
  if (isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIPv6(addr)) {
    const v = addr.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff")
    );
  }
  return true;
}

export type HostResolver = (host: string) => Promise<string[]>;

const resolveAll: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

/** Resolves `host` and refuses internal addresses: the web server calls user-entered hosts. */
export async function isPublicHost(
  host: string,
  resolve: HostResolver = resolveAll,
): Promise<boolean> {
  try {
    const addrs = await resolve(host);
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

const KEY_LINE = /^\S+ (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+$/;

/** `ssh-keyscan` the host's keys (known_hosts lines), or null when none could be fetched. */
export async function scanSshHostKeys(host: string): Promise<string | null> {
  try {
    const { stdout } = await exec("ssh-keyscan", ["-T", "5", "-t", "ed25519,rsa,ecdsa", host], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => KEY_LINE.test(l));
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}
