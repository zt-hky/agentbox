import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitApiError,
  deleteSshKey,
  exchangeOAuthCode,
  fetchGitProfile,
  refreshOAuthToken,
  sshKeyMaterial,
  uploadSshKey,
  type GitAuth,
} from "../src/git-api.ts";

interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}
function stub(...replies: (Response | ((c: Call) => Response))[]) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const raw = init.body as string | undefined;
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* form body */
      }
      const call = { url, init, body };
      calls.push(call);
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return typeof r === "function" ? r(call) : r;
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const client = { clientId: "cid", clientSecret: "sec" };
const auth = (over: Partial<GitAuth> = {}): GitAuth => ({
  provider: "github",
  host: "github.com",
  method: "oauth",
  token: "tok",
  ...over,
});
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake agentbox:alice";

describe("exchangeOAuthCode / refreshOAuthToken", () => {
  it("github exchanges as JSON", async () => {
    const calls = stub(Response.json({ access_token: "t", scope: "repo,write:public_key" }));
    expect(await exchangeOAuthCode("github", client, "code", "https://app/cb")).toEqual({
      accessToken: "t",
      refreshToken: null,
      expiresIn: null,
      scope: "repo,write:public_key",
    });
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[0]!.body).toEqual({
      client_id: "cid",
      client_secret: "sec",
      code: "code",
      redirect_uri: "https://app/cb",
    });
  });

  it("gitlab exchanges as a form and returns refresh data", async () => {
    const calls = stub(
      Response.json({ access_token: "a", refresh_token: "r", expires_in: 7200, scope: "api" }),
    );
    const t = await exchangeOAuthCode("gitlab", client, "code", "https://app/cb");
    expect(t).toMatchObject({ accessToken: "a", refreshToken: "r", expiresIn: 7200 });
    const form = new URLSearchParams(calls[0]!.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("sec");
    expect(form.get("redirect_uri")).toBe("https://app/cb");
  });

  it("bitbucket authenticates with Basic auth and sends no client secret in the body", async () => {
    const calls = stub(
      Response.json({
        access_token: "a",
        refresh_token: "r",
        expires_in: "7200",
        scopes: "account repository:write",
      }),
    );
    const t = await exchangeOAuthCode("bitbucket", client, "code", "https://app/cb");
    expect(t).toMatchObject({ expiresIn: 7200, scope: "account repository:write" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    );
    expect(calls[0]!.body as string).not.toContain("sec");
  });

  it("refresh uses the refresh_token grant per provider", async () => {
    const calls = stub(() =>
      Response.json({ access_token: "n", refresh_token: "r2", expires_in: 3600 }),
    );
    await refreshOAuthToken("gitlab", client, "r1");
    const form = new URLSearchParams(calls[0]!.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("r1");
    expect(form.get("client_id")).toBe("cid");
    await refreshOAuthToken("bitbucket", client, "r1");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    await expect(refreshOAuthToken("github", client, "r")).rejects.toThrow(/do not refresh/);
  });

  it("errors carry the provider's message and status", async () => {
    stub(Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }));
    await expect(refreshOAuthToken("gitlab", client, "r")).rejects.toMatchObject({
      message: "revoked",
      status: 400,
    });
    stub(new Response("nope", { status: 500 }));
    await expect(exchangeOAuthCode("github", client, "c", "u")).rejects.toBeInstanceOf(GitApiError);
  });

  it("never follows redirects", async () => {
    const calls = stub(Response.json({}));
    await fetchGitProfile(auth()).catch(() => undefined);
    expect(calls[0]!.init.redirect).toBe("error");
  });
});

describe("fetchGitProfile", () => {
  it("github: id, login and the noreply email", async () => {
    const calls = stub(Response.json({ id: 42, login: "octo" }));
    expect(await fetchGitProfile(auth())).toEqual({
      providerUserId: "42",
      login: "octo",
      email: "42+octo@users.noreply.github.com",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/user");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("gitlab prefers commit_email, then public_email, then the noreply address", async () => {
    const a = auth({ provider: "gitlab", host: "gitlab.com" });
    stub(Response.json({ id: 7, username: "lab", commit_email: "c@x.io", public_email: "p@x.io" }));
    expect((await fetchGitProfile(a)).email).toBe("c@x.io");
    stub(Response.json({ id: 7, username: "lab", commit_email: "", public_email: "p@x.io" }));
    expect((await fetchGitProfile(a)).email).toBe("p@x.io");
    const calls = stub(Response.json({ id: 7, username: "lab", public_email: "" }));
    expect((await fetchGitProfile(a)).email).toBe("7-lab@users.noreply.gitlab.com");
    expect(calls[0]!.url).toBe("https://gitlab.com/api/v4/user");
  });

  it("self-hosted gitlab and gitea use the entered host", async () => {
    const calls = stub(
      Response.json({ id: 1, username: "u" }),
      Response.json({ id: 2, login: "g", email: "g@x.io" }),
    );
    await fetchGitProfile(auth({ provider: "gitlab-self", host: "git.corp.io", method: "token" }));
    const g = await fetchGitProfile(
      auth({ provider: "gitea", host: "gitea.corp.io", method: "token" }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://git.corp.io/api/v4/user",
      "https://gitea.corp.io/api/v1/user",
    ]);
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("token tok");
    expect(g).toEqual({ providerUserId: "2", login: "g", email: "g@x.io" });
  });

  it("bitbucket: uuid and nickname, no email; generic has no API", async () => {
    stub(Response.json({ uuid: "{u-1}", nickname: "bb" }));
    expect(await fetchGitProfile(auth({ provider: "bitbucket", host: "bitbucket.org" }))).toEqual({
      providerUserId: "{u-1}",
      login: "bb",
      email: null,
    });
    await expect(
      fetchGitProfile(auth({ provider: "generic", host: "x.io", method: "token" })),
    ).rejects.toThrow(/no API/);
  });

  it("a rejected token throws GitApiError with the status", async () => {
    stub(new Response("{}", { status: 401 }));
    await expect(fetchGitProfile(auth())).rejects.toMatchObject({
      name: "GitApiError",
      status: 401,
    });
  });
});

describe("ssh keys", () => {
  it("compares key material and ignores comments", () => {
    expect(sshKeyMaterial("ssh-ed25519 AAAA my comment")).toBe("ssh-ed25519 AAAA");
    expect(sshKeyMaterial("ssh-ed25519 AAAA\n")).toBe("ssh-ed25519 AAAA");
  });

  it("lists first and reuses an existing key (no POST)", async () => {
    const calls = stub(
      Response.json([{ id: 9, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake other-comment" }]),
    );
    expect(await uploadSshKey(auth(), null, KEY, "AgentBox alice")).toBe("9");
    expect(calls.map((c) => c.init.method ?? "GET")).toEqual(["GET"]);
  });

  it("posts when absent and returns the new id; gitlab/gitea use their endpoints and payloads", async () => {
    const calls = stub(
      Response.json([]),
      Response.json({ id: 31 }),
      Response.json([]),
      Response.json({ id: 32 }),
    );
    expect(
      await uploadSshKey(
        auth({ provider: "gitlab", host: "gitlab.com" }),
        null,
        KEY,
        "AgentBox alice",
      ),
    ).toBe("31");
    expect(calls[1]!.url).toBe("https://gitlab.com/api/v4/user/keys");
    expect(calls[1]!.body).toEqual({ key: KEY, title: "AgentBox alice" });
    expect(
      await uploadSshKey(
        auth({ provider: "gitea", host: "g.corp.io", method: "token" }),
        null,
        KEY,
        "t",
      ),
    ).toBe("32");
    expect(calls[3]!.body).toEqual({ key: KEY, title: "t", read_only: false });
  });

  it("bitbucket pages through the key list and needs the account uuid", async () => {
    const a = auth({ provider: "bitbucket", host: "bitbucket.org" });
    await expect(uploadSshKey(a, null, KEY, "t")).rejects.toThrow(/account id/);
    const calls = stub(
      Response.json({
        values: [{ uuid: "{k0}", key: "ssh-rsa BBBB" }],
        next: "https://api.bitbucket.org/2.0/users/x/ssh-keys?page=2",
      }),
      Response.json({ values: [{ uuid: "{k1}", key: KEY }] }),
    );
    expect(await uploadSshKey(a, "{u}", KEY, "t")).toBe("{k1}");
    expect(calls[1]!.url).toBe("https://api.bitbucket.org/2.0/users/x/ssh-keys?page=2");
  });

  it("does not follow a `next` link that leaves the API host", async () => {
    const a = auth({ provider: "bitbucket", host: "bitbucket.org" });
    const calls = stub(
      Response.json({ values: [], next: "https://evil.example/steal" }),
      Response.json({ uuid: "{new}" }),
    );
    expect(await uploadSshKey(a, "{u}", KEY, "t")).toBe("{new}");
    expect(calls.map((c) => c.url)).not.toContain("https://evil.example/steal");
  });

  it("delete treats 404 as done and surfaces other failures", async () => {
    const calls = stub(new Response(null, { status: 404 }));
    await deleteSshKey(auth(), null, "9");
    expect(calls[0]!.url).toBe("https://api.github.com/user/keys/9");
    expect(calls[0]!.init.method).toBe("DELETE");
    stub(new Response(null, { status: 403 }));
    await expect(deleteSshKey(auth(), null, "9")).rejects.toMatchObject({ status: 403 });
  });
});
