import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubConnectConfig } from "../lib/env";
import {
  GH_STATE_COOKIE,
  authorizeUrl,
  exchangeCode,
  isConnectCallback,
  revokeConnection,
} from "../lib/github";

const KEYS = [
  "GITHUB_CONNECT_CLIENT_ID",
  "GITHUB_CONNECT_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "APP_ORIGIN",
  "BETTER_AUTH_URL",
];

describe("github connect", () => {
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
    expect(githubConnectConfig()).toBeNull();
    process.env.GITHUB_CLIENT_ID = "sid";
    process.env.GITHUB_CLIENT_SECRET = "ssec";
    expect(githubConnectConfig()).toEqual({
      clientId: "sid",
      clientSecret: "ssec",
      callbackPath: "/api/auth/callback/github",
      shared: true,
    });
    process.env.GITHUB_CONNECT_CLIENT_ID = "did";
    expect(githubConnectConfig()?.clientId).toBe("sid");
    process.env.GITHUB_CONNECT_CLIENT_SECRET = "dsec";
    expect(githubConnectConfig()).toEqual({
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
    const u = new URL(authorizeUrl(cfg, "st"));
    expect(new URL(u.searchParams.get("redirect_uri")!).pathname).toBe(cfg.callbackPath);
    const fetchMock = vi.fn(async () => Response.json({ access_token: "t", scope: "repo" }));
    vi.stubGlobal("fetch", fetchMock);
    await exchangeCode(cfg, "code");
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(new URL(body.redirect_uri).pathname).toBe(cfg.callbackPath);
  });

  it("routes the shared callback to Connect only when the state matches its cookie", () => {
    const cb = "https://app.example/api/auth/callback/github?code=c&state=";
    const withCookie = (state: string, cookie?: string) =>
      new Request(cb + state, cookie ? { headers: { cookie } } : undefined);
    expect(isConnectCallback(withCookie("abc", `x=1; ${GH_STATE_COOKIE}=abc`))).toBe(true);
    // A sign-in callback: better-auth's own state, stale or absent Connect cookie.
    expect(isConnectCallback(withCookie("signin", `${GH_STATE_COOKIE}=abc`))).toBe(false);
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
