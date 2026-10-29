import { TENANT_UID_BASE } from "./config.ts";

/** cgroup paths come from `podman inspect`; only accept plain absolute paths. */
export function isSafeCgroupPath(p: string): boolean {
  if (!p.startsWith("/") || p.length > 512) return false;
  return p.split("/").every((seg) => seg !== ".." && seg !== "." && !/[\0\r\n]/.test(seg));
}

export function isTenantUid(uid: number): boolean {
  return Number.isInteger(uid) && uid > TENANT_UID_BASE && uid <= TENANT_UID_BASE + 4999;
}

export function slotOfUid(uid: number): number {
  return uid - TENANT_UID_BASE;
}

/** Values interpolated into argv positions that tools could mistake for options. */
export function isPlainArg(s: string): boolean {
  return s.length > 0 && s.length <= 256 && !s.startsWith("-") && !/[\0\r\n]/.test(s);
}

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}
