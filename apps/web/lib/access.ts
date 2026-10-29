import { sanitizeNextPath } from "./paths";

export interface AccessUser {
  role?: string | null;
  accessStatus?: string | null;
}

export type AccessDecision = { type: "next" } | { type: "redirect"; to: string };

/** Route-level gate evaluated by the proxy. Pages and actions re-check independently. */
export function decideAccess(input: {
  pathname: string;
  search: string;
  user: AccessUser | null;
}): AccessDecision {
  const { pathname, search, user } = input;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return { type: "next" };

  const active = user?.accessStatus === "active";

  if (pathname === "/login") {
    if (!user) return { type: "next" };
    if (!active) return { type: "redirect", to: "/request-access" };
    return { type: "redirect", to: sanitizeNextPath(new URLSearchParams(search).get("next")) };
  }

  if (!user) {
    return { type: "redirect", to: `/login?next=${encodeURIComponent(pathname + search)}` };
  }

  if (!active) {
    return pathname === "/request-access"
      ? { type: "next" }
      : { type: "redirect", to: "/request-access" };
  }

  if (pathname === "/request-access") return { type: "redirect", to: "/" };
  if ((pathname === "/admin" || pathname.startsWith("/admin/")) && user.role !== "admin") {
    return { type: "redirect", to: "/" };
  }
  return { type: "next" };
}
