import { githubScopeString } from "@agentbox/core/accounts";
import { timingSafeEqual } from "node:crypto";
import { appOrigin } from "./env";

export const GH_STATE_COOKIE = "__Host-abx_gh_state";
export const GH_STATE_MAX_AGE_S = 600;
export const WORKFLOW_PARAM = "workflow";

export function callbackUrl(): string {
  return `${appOrigin()}/api/github/callback`;
}

/** `allowWorkflow` is the opt-in for editing workflow files; everything else is the minimum for git + gh. */
export function authorizeUrl(clientId: string, state: string, allowWorkflow = false): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("scope", githubScopeString(allowWorkflow));
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", callbackUrl());
  return u.toString();
}

export function stateCookie(value: string, maxAge = GH_STATE_MAX_AGE_S): string {
  return `${GH_STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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

/** Relative-Location redirect (the Node server only sees http behind the TLS-terminating tunnel). */
export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

const TIMEOUT_MS = 10_000;

export async function exchangeCode(
  cfg: { clientId: string; clientSecret: string },
  code: string,
): Promise<{ accessToken: string; scope: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: callbackUrl(),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!res.ok || !body.access_token)
    throw new Error(body.error ?? `token exchange failed (${res.status})`);
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

export async function fetchGithubUser(token: string): Promise<{ id: number; login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agentbox",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /user failed (${res.status})`);
  const body = (await res.json()) as { id?: number; login?: string };
  if (typeof body.id !== "number" || !body.login) throw new Error("unexpected GET /user response");
  return { id: body.id, login: body.login };
}

/** Revoke the OAuth grant. Best effort: callers ignore failures. */
export async function revokeGrant(
  cfg: { clientId: string; clientSecret: string },
  token: string,
): Promise<void> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  await fetch(`https://api.github.com/applications/${encodeURIComponent(cfg.clientId)}/grant`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      "User-Agent": "agentbox",
    },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
