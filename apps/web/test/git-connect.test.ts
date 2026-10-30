import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeOAuthCode } from "@agentbox/core/git-api";
import { gitOAuthConfig } from "../lib/env";
import {
  GIT_STATE_COOKIE,
  authorizeUrl,
  callbackUrl,
  isConnectCallback,
  returnBase,
  revokeConnection,
} from "../lib/git-oauth";

const KEYS = [
  "GITHUB_CONNECT_CLIENT_ID",
  "GITHUB_CONNECT_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "APP_ORIGIN",
  "BETTER_AUTH_URL",
  "GITLAB_CLIENT_ID",
  "GITLAB_CLIENT_SECRET",
  "BITBUCKET_CLIENT_ID",
  "BITBUCKET_CLIENT_SECRET",
];

describe("git connect", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it("prefers dedicated, then shared, then null", () => {
    expect(gitOAuthConfig("github")).toBeNull();
    process.env.GITHUB_CLIENT_ID = "sid";
    process.env.GITHUB_CLIENT_SECRET = "ssec";
    expect(gitOAuthConfig("github")).toEqual({
      clientId: "sid",
      clientSecret: "ssec",
      callbackPath: "/api/auth/callback/github",
      shared: true,
    });
    process.env.GITHUB_CONNECT_CLIENT_ID = "did";
    expect(gitOAuthConfig("github")?.clientId).toBe("sid");
    process.env.GITHUB_CONNECT_CLIENT_SECRET = "dsec";
    expect(gitOAuthConfig("github")).toEqual({
      clientId: "did",
      clientSecret: "dsec",
      callbackPath: "/api/github/callback",
      shared: false,
    });
  });

  it("uses the config callback path for authorize and token exchange", async () => {
    const cfg = {
      clientId: "sid",
      clientSecret: "ssec",
      callbackPath: "/api/auth/callback/github",
    };
    const u = new URL(authorizeUrl("github", cfg, "st"));
    expect(new URL(u.searchParams.get("redirect_uri")!).pathname).toBe(cfg.callbackPath);
    const fetchMock = vi.fn(async () => Response.json({ access_token: "t", scope: "repo" }));
    vi.stubGlobal("fetch", fetchMock);
    await exchangeOAuthCode("github", cfg, "code", callbackUrl(cfg));
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(new URL(body.redirect_uri).pathname).toBe(cfg.callbackPath);
  });

  it("gitlab and bitbucket are configured by their own env, with fixed callbacks", () => {
    expect(gitOAuthConfig("gitlab")).toBeNull();
    expect(gitOAuthConfig("bitbucket")).toBeNull();
    process.env.GITLAB_CLIENT_ID = "gid";
    expect(gitOAuthConfig("gitlab")).toBeNull();
    process.env.GITLAB_CLIENT_SECRET = "gsec";
    process.env.BITBUCKET_CLIENT_ID = "bid";
    process.env.BITBUCKET_CLIENT_SECRET = "bsec";
    expect(gitOAuthConfig("gitlab")).toEqual({
      clientId: "gid",
      clientSecret: "gsec",
      callbackPath: "/api/git/gitlab/callback",
      shared: false,
    });
    expect(gitOAuthConfig("bitbucket")?.callbackPath).toBe("/api/git/bitbucket/callback");
  });

  it("builds the authorize URL per provider", () => {
    const gl = new URL(
      authorizeUrl("gitlab", { clientId: "gid", callbackPath: "/api/git/gitlab/callback" }, "st"),
    );
    expect(gl.origin + gl.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(gl.searchParams.get("scope")).toBe("api read_user write_repository");
    expect(gl.searchParams.get("response_type")).toBe("code");
    expect(new URL(gl.searchParams.get("redirect_uri")!).pathname).toBe("/api/git/gitlab/callback");
    const bb = new URL(
      authorizeUrl(
        "bitbucket",
        { clientId: "bid", callbackPath: "/api/git/bitbucket/callback" },
        "st",
      ),
    );
    expect(bb.origin + bb.pathname).toBe("https://bitbucket.org/site/oauth2/authorize");
    expect(bb.searchParams.get("scope")).toBeNull();
    expect(bb.searchParams.get("state")).toBe("st");
  });

  it("returns to onboarding only when it started there", () => {
    expect(returnBase("/onboarding")).toBe("/onboarding");
    expect(returnBase(null)).toBe("/settings/accounts");
    expect(returnBase("https://evil.example")).toBe("/settings/accounts");
  });

  it("routes the shared callback to Connect only when the state matches its cookie", () => {
    const cb = "https://app.example/api/auth/callback/github?code=c&state=";
    const withCookie = (state: string, cookie?: string) =>
      new Request(cb + state, cookie ? { headers: { cookie } } : undefined);
    expect(isConnectCallback(withCookie("abc", `x=1; ${GIT_STATE_COOKIE}=abc`))).toBe(true);
    // A sign-in callback: better-auth's own state, stale or absent Connect cookie.
    expect(isConnectCallback(withCookie("signin", `${GIT_STATE_COOKIE}=abc`))).toBe(false);
    expect(isConnectCallback(withCookie("abc"))).toBe(false);
  });

  it("shared disconnect revokes the token, dedicated revokes the grant", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await revokeConnection({ clientId: "sid", clientSecret: "s", shared: true }, "tok");
    await revokeConnection({ clientId: "did", clientSecret: "s", shared: false }, "tok");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("https://api.github.com/applications/sid/token");
    expect(calls[0]![1].method).toBe("DELETE");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ access_token: "tok" });
    expect(calls[1]![0]).toBe("https://api.github.com/applications/did/grant");
  });
});
