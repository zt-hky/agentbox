import { headers } from "next/headers";
import { GIT_OAUTH, isGitOAuthProvider, type GitOAuthProviderId } from "@agentbox/core/git";
import { exchangeOAuthCode, fetchGitProfile } from "@agentbox/core/git-api";
import { db } from "@agentbox/db/client";
import { gitOAuthConfig } from "@/lib/env";
import { upsertGitConnection } from "@/lib/git-accounts";
import {
  GIT_NEXT_COOKIE,
  GIT_STATE_COOKIE,
  callbackUrl,
  nextCookie,
  readCookie,
  redirectResponse,
  returnBase,
  stateCookie,
  statesMatch,
} from "@/lib/git-oauth";
import { getClientIp, getSession } from "@/lib/session";

export function parseOAuthProvider(value: string): GitOAuthProviderId | null {
  return isGitOAuthProvider(value) ? value : null;
}

/** OAuth redirect target for every provider: verify state, swap the code, store the connection. */
export async function handleGitCallback(
  provider: GitOAuthProviderId,
  request: Request,
): Promise<Response> {
  const clearState = stateCookie("", 0);
  const clear = [clearState, nextCookie("", 0)];
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active")
    return redirectResponse("/login", [clearState]);
  const cfg = gitOAuthConfig(provider);
  if (!cfg) return new Response("This git provider is not configured", { status: 404 });

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieHeader = (await headers()).get("cookie");
  const cookieState = readCookie(cookieHeader, GIT_STATE_COOKIE);
  const base = returnBase(readCookie(cookieHeader, GIT_NEXT_COOKIE));
  if (!statesMatch(state, cookieState)) return redirectResponse(`${base}?error=state`, clear);
  if (url.searchParams.get("error") === "access_denied") {
    return redirectResponse(`${base}?error=denied`, clear);
  }
  if (!code) return redirectResponse(`${base}?error=state`, clear);

  try {
    const tokens = await exchangeOAuthCode(provider, cfg, code, callbackUrl(cfg));
    const host = GIT_OAUTH[provider].host;
    const profile = await fetchGitProfile({
      provider,
      host,
      method: "oauth",
      token: tokens.accessToken,
    });
    await upsertGitConnection(db, {
      userId: session.user.id,
      provider,
      host,
      method: "oauth",
      login: profile.login,
      email: profile.email,
      providerUserId: profile.providerUserId,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      scopes: tokens.scope || null,
      ip: await getClientIp(),
    });
  } catch (e) {
    console.error(`${provider} connect failed`, e);
    return redirectResponse(`${base}?error=exchange`, clear);
  }
  return redirectResponse(`${base}?connected=${provider}`, clear);
}
