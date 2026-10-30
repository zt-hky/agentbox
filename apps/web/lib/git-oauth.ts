import { GIT_OAUTH, gitOAuthScopes, type GitOAuthProviderId } from "@agentbox/core/git";
import { timingSafeEqual } from "node:crypto";
import { appOrigin, type GitOAuthConfig } from "./env";

export const GIT_STATE_COOKIE = "__Host-abx_git_state";
export const GIT_STATE_MAX_AGE_S = 600;
/** Where to return after the OAuth round trip; only the onboarding wizard sets it. */
export const GIT_NEXT_COOKIE = "__Host-abx_git_next";
export const ONBOARDING_RETURN = "/onboarding";
export const WORKFLOW_PARAM = "workflow";

export function callbackUrl(cfg: Pick<GitOAuthConfig, "callbackPath">): string {
  return `${appOrigin()}${cfg.callbackPath}`;
}

/** `allowWorkflow` is the opt-in for GitHub workflow files; everything else is the minimum for git (+ gh). */
export function authorizeUrl(
  provider: GitOAuthProviderId,
  cfg: Pick<GitOAuthConfig, "clientId" | "callbackPath">,
  state: string,
  allowWorkflow = false,
): string {
  const u = new URL(GIT_OAUTH[provider].authorizeUrl);
  u.searchParams.set("client_id", cfg.clientId);
  // Bitbucket takes its scopes from the consumer configuration.
  const scope = provider === "bitbucket" ? null : gitOAuthScopes(provider, allowWorkflow);
  if (scope) u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", callbackUrl(cfg));
  if (provider !== "github") u.searchParams.set("response_type", "code");
  return u.toString();
}

export function stateCookie(value: string, maxAge = GIT_STATE_MAX_AGE_S): string {
  return `${GIT_STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function nextCookie(value: string, maxAge = GIT_STATE_MAX_AGE_S): string {
  return `${GIT_NEXT_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** The return page for a Connect round trip: onboarding when it started there, else Accounts. */
export function returnBase(nextValue: string | null): string {
  return nextValue === ONBOARDING_RETURN ? ONBOARDING_RETURN : "/settings/accounts";
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function statesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A request on the shared sign-in callback belongs to Connect only when it carries Connect's state. */
export function isConnectCallback(request: Request): boolean {
  const url = new URL(request.url);
  return statesMatch(
    url.searchParams.get("state"),
    readCookie(request.headers.get("cookie"), GIT_STATE_COOKIE),
  );
}

/** Relative-Location redirect (the Node server only sees http behind the TLS-terminating tunnel). */
export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

const TIMEOUT_MS = 10_000;

function basicAuth(cfg: Pick<GitOAuthConfig, "clientId" | "clientSecret">): string {
  return Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
}

async function deleteApplication(
  cfg: Pick<GitOAuthConfig, "clientId" | "clientSecret">,
  kind: "grant" | "token",
  token: string,
): Promise<void> {
  await fetch(`https://api.github.com/applications/${encodeURIComponent(cfg.clientId)}/${kind}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${basicAuth(cfg)}`,
      "Content-Type": "application/json",
      "User-Agent": "agentbox",
    },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Revoke what Connect handed out. A dedicated app owns the whole grant, so it is removed. A shared
 * app's grant is also the user's sign-in authorization, so only this token is revoked.
 * Best effort: callers ignore failures.
 */
export async function revokeConnection(
  cfg: Pick<GitOAuthConfig, "clientId" | "clientSecret" | "shared">,
  token: string,
): Promise<void> {
  await deleteApplication(cfg, cfg.shared ? "token" : "grant", token);
}
