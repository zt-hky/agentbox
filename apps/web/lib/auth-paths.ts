/** better-auth routes that must not be reachable over HTTP. */
export function isBlockedAuthPath(pathname: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  p = p
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  return p === "/api/auth/admin" || p.startsWith("/api/auth/admin/");
}
