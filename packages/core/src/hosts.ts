export const SERVICES = { t3: { port: 3773 }, code: { port: 8080 } } as const;
export type ServiceName = keyof typeof SERVICES;

export const RESERVED_LABELS = [
  "app",
  "api",
  "admin",
  "auth",
  "www",
  "docs",
  "status",
  "mail",
  "static",
  "assets",
  "cdn",
  "internal",
  "gateway",
  "registry",
] as const;

const SLUG_RE = /^[a-z][a-z0-9]{2,19}$/;

export function isValidWorkspaceSlug(s: string): boolean {
  return SLUG_RE.test(s) && !(RESERVED_LABELS as readonly string[]).includes(s);
}

function isServiceName(s: string): s is ServiceName {
  return Object.prototype.hasOwnProperty.call(SERVICES, s);
}

export function parseWorkspaceHost(
  host: string,
  baseDomain: string,
): { ws: string; svc: ServiceName } | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (label.length === 0 || label.includes(".")) return null;
  const idx = label.lastIndexOf("-");
  if (idx < 0) return null;
  const ws = label.slice(0, idx);
  const svc = label.slice(idx + 1);
  if (!isValidWorkspaceSlug(ws) || !isServiceName(svc)) return null;
  return { ws, svc };
}

export function workspaceUrl(ws: string, svc: ServiceName, baseDomain: string): string {
  return `https://${ws}-${svc}.${baseDomain}/`;
}
