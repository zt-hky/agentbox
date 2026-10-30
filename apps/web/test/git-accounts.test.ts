import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@agentbox/core/tokens";
import { auditLog, gitConnections, jobs, workspaces } from "@agentbox/db/schema";
import { UserError } from "../lib/errors";
import {
  addGitTokenConnection,
  loadGitAccountsView,
  releaseDisconnectedConnection,
  upsertGitConnection,
} from "../lib/git-accounts";
import { isPrivateAddress, isPublicHost } from "../lib/git-host";
import { createTestDb, seedUser, type TestDb } from "./helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, cookie: "", session: null as unknown }));
vi.mock("@agentbox/db/client", async (orig) => ({
  ...(await orig<typeof import("@agentbox/db/client")>()),
  get db() {
    return holder.db;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: holder.cookie }) }));
vi.mock("@/lib/session", () => ({
  getSession: async () => holder.session,
  getClientIp: async () => "198.51.100.7",
}));

const { handleGitCallback } = await import("../lib/git-callback");

const ENC = randomBytes(32).toString("base64");
const PUBLIC = async () => ["93.184.216.34"];
const SCAN = async (host: string) => `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIScanned`;
const ip = "198.51.100.9";
let t: TestDb;
let n = 0;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  saved = Object.fromEntries(
    [
      "AGENTBOX_ENCRYPTION_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITLAB_CLIENT_ID",
      "GITLAB_CLIENT_SECRET",
    ].map((k) => [k, process.env[k]]),
  );
  process.env.AGENTBOX_ENCRYPTION_KEY = ENC;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t.close();
});
beforeEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GITLAB_CLIENT_ID;
  delete process.env.GITLAB_CLIENT_SECRET;
});
afterEach(() => vi.unstubAllGlobals());

async function seed(status: (typeof workspaces.$inferInsert)["status"] = "running") {
  n++;
  const userId = await seedUser(t.db, `git${n}@example.com`, "active");
  const [ws] = await t.db
    .insert(workspaces)
    .values({ userId, slug: `git${n}x`, slot: 300 + n, status, identitySecretEnc: "x" })
    .returning();
  return { userId, ws: ws! };
}
const rows = (userId: string) =>
  t.db.select().from(gitConnections).where(eq(gitConnections.userId, userId));
const jobTypes = async (workspaceId: string) =>
  (await t.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId))).map((j) => j.type);

function stubFetch(handler: (url: string, init: RequestInit) => Response | undefined) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const raw = init.body as string | undefined;
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* form */
      }
      calls.push({ url, method: init.method ?? "GET", body });
      return handler(url, init) ?? new Response(null, { status: 204 });
    }),
  );
  return calls;
}

describe("host safety", () => {
  it("classifies private and public addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"])
      expect(isPrivateAddress(a), a).toBe(false);
  });
  it("refuses hosts that resolve to anything internal or not at all", async () => {
    expect(await isPublicHost("a.example.com", async () => ["93.184.216.34"])).toBe(true);
    expect(await isPublicHost("a.example.com", async () => ["93.184.216.34", "10.0.0.5"])).toBe(
      false,
    );
    expect(await isPublicHost("a.example.com", async () => [])).toBe(false);
    expect(
      await isPublicHost("a.example.com", async () => Promise.reject(new Error("ENOTFOUND"))),
    ).toBe(false);
  });
});

describe("addGitTokenConnection", () => {
  const input = (userId: string, over: Record<string, string> = {}) => ({
    userId,
    provider: "gitea",
    host: "git.example.com",
    username: "me",
    token: "tok_123",
    ip,
    ...over,
  });
  const deps = { resolve: PUBLIC, scan: SCAN };

  it.each([
    ["localhost", "localhost"],
    ["an IP address", "203.0.113.5"],
    ["a loopback IP", "127.0.0.1"],
    ["an http URL", "http://git.example.com"],
    ["a host with a port", "git.example.com:3000"],
    ["a path", "git.example.com/x"],
    ["empty", ""],
  ])("rejects %s as a host", async (_n, host) => {
    const { userId } = await seed();
    await expect(addGitTokenConnection(t.db, input(userId, { host }), deps)).rejects.toThrow(
      /valid hostname/,
    );
    expect(await rows(userId)).toHaveLength(0);
  });

  it("rejects a host that resolves to a private address, an unknown provider and bad credentials", async () => {
    const { userId } = await seed();
    await expect(
      addGitTokenConnection(t.db, input(userId), { ...deps, resolve: async () => ["10.0.0.1"] }),
    ).rejects.toThrow(/not a public address/);
    await expect(
      addGitTokenConnection(t.db, input(userId, { provider: "github" }), deps),
    ).rejects.toThrow(/Unsupported/);
    await expect(
      addGitTokenConnection(t.db, input(userId, { token: "a b" }), deps),
    ).rejects.toThrow(/token/);
    await expect(
      addGitTokenConnection(t.db, input(userId, { token: "a\nb" }), deps),
    ).rejects.toThrow(UserError);
    await expect(
      addGitTokenConnection(t.db, input(userId, { username: "-x" }), deps),
    ).rejects.toThrow(/username/);
    expect(await rows(userId)).toHaveLength(0);
  });

  it("verifies a Gitea token against the host API, stores it encrypted with scanned keys and queues a sync", async () => {
    const { userId, ws } = await seed();
    process.env.AGENTBOX_ENCRYPTION_KEY = ENC;
    const calls = stubFetch(() =>
      Response.json({ id: 5, login: "realme", email: "me@git.example.com" }),
    );
    const res = await addGitTokenConnection(
      t.db,
      input(userId, { host: " Git.Example.COM " }),
      deps,
    );
    expect(calls.map((c) => c.url)).toEqual(["https://git.example.com/api/v1/user"]);
    const [c] = await rows(userId);
    expect(c).toMatchObject({
      id: res.id,
      provider: "gitea",
      host: "git.example.com",
      method: "token",
      login: "realme",
      email: "me@git.example.com",
      providerUserId: "5",
      status: "active",
      knownHosts: "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIScanned",
      refreshTokenEnc: null,
      expiresAt: null,
    });
    expect(c!.tokenEnc).not.toContain("tok_123");
    expect(decrypt(c!.tokenEnc, ENC)).toBe("tok_123");
    expect(await jobTypes(ws.id)).toEqual(["sync_git"]);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, "git.connected"));
    expect(audit.find((a) => a.actorId === userId)?.metadata).toMatchObject({
      host: "git.example.com",
      method: "token",
    });
  });

  it("a rejected token is a user-facing error and stores nothing", async () => {
    const { userId, ws } = await seed();
    stubFetch(() => new Response("{}", { status: 401 }));
    await expect(addGitTokenConnection(t.db, input(userId), deps)).rejects.toThrow(
      "The host rejected this token.",
    );
    expect(await rows(userId)).toHaveLength(0);
    expect(await jobTypes(ws.id)).toEqual([]);
  });

  it("gitlab via token is forced to gitlab.com, pinned (no scan), verified with /api/v4/user", async () => {
    const { userId } = await seed();
    const calls = stubFetch(() => Response.json({ id: 9, username: "lab", public_email: "" }));
    const scan = vi.fn(SCAN);
    await addGitTokenConnection(
      t.db,
      input(userId, { provider: "gitlab", host: "ignored.example.com" }),
      { resolve: PUBLIC, scan },
    );
    expect(calls[0]!.url).toBe("https://gitlab.com/api/v4/user");
    expect(scan).not.toHaveBeenCalled();
    expect(await rows(userId)).toMatchObject([
      {
        provider: "gitlab",
        host: "gitlab.com",
        method: "token",
        login: "lab",
        knownHosts: null,
        email: "9-lab@users.noreply.gitlab.com",
      },
    ]);
  });

  it("a generic host is verified by format only and keeps the typed username", async () => {
    const { userId } = await seed();
    const calls = stubFetch(() => undefined);
    await addGitTokenConnection(
      t.db,
      input(userId, {
        provider: "generic",
        host: "bitbucket.org",
        username: "bbuser",
        token: "app-pass",
      }),
      deps,
    );
    expect(calls).toHaveLength(0);
    expect(await rows(userId)).toMatchObject([
      {
        provider: "generic",
        host: "bitbucket.org",
        login: "bbuser",
        email: null,
        providerUserId: null,
        knownHosts: null,
      },
    ]);
  });

  it("updating the token for the same host replaces it, keeping the uploaded key only for the same account", async () => {
    const { userId } = await seed();
    stubFetch(() => Response.json({ id: 5, login: "me", email: "m@x.io" }));
    await addGitTokenConnection(t.db, input(userId), deps);
    await t.db
      .update(gitConnections)
      .set({ sshKeyId: "k1", status: "error", lastError: "bad" })
      .where(eq(gitConnections.userId, userId));
    await addGitTokenConnection(t.db, input(userId, { token: "newtok" }), deps);
    let [c] = await rows(userId);
    expect(await rows(userId)).toHaveLength(1);
    expect(decrypt(c!.tokenEnc, ENC)).toBe("newtok");
    expect(c).toMatchObject({ sshKeyId: "k1", status: "active", lastError: null });
    stubFetch(() => Response.json({ id: 6, login: "other", email: "o@x.io" }));
    await addGitTokenConnection(t.db, input(userId), deps);
    [c] = await rows(userId);
    expect(c).toMatchObject({ sshKeyId: null, login: "other" });
  });
});

describe("loadGitAccountsView", () => {
  it("lists the three OAuth providers with their configuration and per-connection state", async () => {
    const { userId, ws } = await seed();
    await t.db
      .update(workspaces)
      .set({ sshPublicKey: "ssh-ed25519 AAAA agentbox:x" })
      .where(eq(workspaces.id, ws.id));
    process.env.GITLAB_CLIENT_ID = "i";
    process.env.GITLAB_CLIENT_SECRET = "s";
    const base = { userId, method: "oauth" as const, tokenEnc: "e" };
    await t.db.insert(gitConnections).values([
      { ...base, provider: "github", host: "github.com", login: "octo", scopes: "repo,workflow" },
      {
        ...base,
        provider: "gitlab",
        host: "gitlab.com",
        login: "lab",
        sshKeyId: "7",
        scopes: "api",
      },
      { ...base, provider: "gitea", host: "git.example.com", method: "token", login: "g" },
      {
        ...base,
        provider: "generic",
        host: "code.example.org",
        method: "token",
        login: "x",
        status: "error",
        lastError: "nope",
      },
    ]);
    const view = await loadGitAccountsView(t.db, userId);
    expect(view.hasWorkspace).toBe(true);
    expect(view.workspaceSshPublicKey).toBe("ssh-ed25519 AAAA agentbox:x");
    expect(view.providers.map((p) => [p.id, p.host, p.oauthConfigured, p.connectUrl])).toEqual([
      ["github", "github.com", false, "/api/git/github/connect"],
      ["gitlab", "gitlab.com", true, "/api/git/gitlab/connect"],
      ["bitbucket", "bitbucket.org", false, "/api/git/bitbucket/connect"],
    ]);
    const byHost = Object.fromEntries(view.connections.map((c) => [c.host, c]));
    expect(byHost["github.com"]).toMatchObject({
      ssh: "reconnect",
      workflowScope: true,
      https: true,
    });
    expect(byHost["gitlab.com"]).toMatchObject({ ssh: "uploaded", workflowScope: false });
    expect(byHost["git.example.com"]).toMatchObject({ ssh: "pending" });
    expect(byHost["code.example.org"]).toMatchObject({
      ssh: "manual",
      status: "error",
      lastError: "nope",
    });
    expect(JSON.stringify(view)).not.toContain("tokenEnc");
  });

  it("a user with no workspace has no key to show", async () => {
    const userId = await seedUser(t.db, "nows@example.com", "active");
    expect(await loadGitAccountsView(t.db, userId)).toMatchObject({
      hasWorkspace: false,
      workspaceSshPublicKey: null,
      connections: [],
    });
  });
});

describe("releaseDisconnectedConnection", () => {
  const conn = (over: Partial<typeof gitConnections.$inferSelect>) =>
    ({
      id: "id",
      userId: "u",
      provider: "github",
      host: "github.com",
      method: "oauth",
      login: "octo",
      email: null,
      providerUserId: "42",
      tokenEnc: encrypt("gho_tok", ENC),
      refreshTokenEnc: null,
      expiresAt: null,
      scopes: null,
      sshKeyId: "11",
      knownHosts: null,
      status: "active",
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as typeof gitConnections.$inferSelect;

  it("deletes the uploaded key at the provider, then revokes the OAuth grant", async () => {
    process.env.GITHUB_CLIENT_ID = "cid";
    process.env.GITHUB_CLIENT_SECRET = "sec";
    const calls = stubFetch(() => undefined);
    await releaseDisconnectedConnection(conn({}));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE https://api.github.com/user/keys/11",
      "DELETE https://api.github.com/applications/cid/token",
    ]);
  });

  it("skips key deletion when nothing was uploaded and never throws on provider failures", async () => {
    const calls = stubFetch(() => undefined);
    await releaseDisconnectedConnection(conn({ sshKeyId: null }));
    expect(calls).toHaveLength(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    await expect(releaseDisconnectedConnection(conn({}))).resolves.toBeUndefined();
  });

  it("gitea token connections delete the key with token auth and have no grant to revoke", async () => {
    const calls = stubFetch(() => undefined);
    await releaseDisconnectedConnection(
      conn({ provider: "gitea", host: "git.example.com", method: "token", sshKeyId: "3" }),
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE https://git.example.com/api/v1/user/keys/3",
    ]);
  });

  it("an unreadable token is skipped quietly", async () => {
    const calls = stubFetch(() => undefined);
    await releaseDisconnectedConnection(conn({ tokenEnc: "garbage" }));
    expect(calls).toHaveLength(0);
  });
});

describe("OAuth callback", () => {
  const session = (userId: string) => ({ user: { id: userId, accessStatus: "active" } });
  const req = (path: string, qs: string) => new Request(`https://app.agentbox.io.vn${path}?${qs}`);
  const setup = async (cookies = "__Host-abx_git_state=st; __Host-abx_git_next=/onboarding") => {
    const s = await seed();
    holder.session = session(s.userId);
    holder.cookie = cookies;
    return s;
  };

  it("github: exchanges the code, stores token + scopes + noreply email, queues sync_git, returns to onboarding", async () => {
    process.env.GITHUB_CLIENT_ID = "sid";
    process.env.GITHUB_CLIENT_SECRET = "ssec";
    const { userId, ws } = await setup();
    const calls = stubFetch((url) =>
      url.includes("access_token")
        ? Response.json({ access_token: "gho_new", scope: "repo,read:org,gist,write:public_key" })
        : Response.json({ id: 42, login: "octo" }),
    );
    const res = await handleGitCallback(
      "github",
      req("/api/auth/callback/github", "code=abc&state=st"),
    );
    expect(res.headers.get("location")).toBe("/onboarding?connected=github");
    expect(calls.map((c) => c.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    const [c] = await rows(userId);
    expect(c).toMatchObject({
      provider: "github",
      host: "github.com",
      method: "oauth",
      login: "octo",
      providerUserId: "42",
      email: "42+octo@users.noreply.github.com",
      scopes: "repo,read:org,gist,write:public_key",
      refreshTokenEnc: null,
      expiresAt: null,
    });
    expect(decrypt(c!.tokenEnc, ENC)).toBe("gho_new");
    expect(await jobTypes(ws.id)).toEqual(["sync_git"]);
    expect(res.headers.getSetCookie().join(";")).toContain("Max-Age=0");
  });

  it("gitlab: stores the refresh token and expiry and returns to the Accounts page", async () => {
    process.env.GITLAB_CLIENT_ID = "gid";
    process.env.GITLAB_CLIENT_SECRET = "gsec";
    const { userId } = await setup("__Host-abx_git_state=st");
    const before = Date.now();
    stubFetch((url) =>
      url.includes("/oauth/token")
        ? Response.json({
            access_token: "gl_a",
            refresh_token: "gl_r",
            expires_in: 7200,
            scope: "api read_user write_repository",
          })
        : Response.json({ id: 9, username: "lab", commit_email: "lab@x.io" }),
    );
    const res = await handleGitCallback(
      "gitlab",
      req("/api/git/gitlab/callback", "code=abc&state=st"),
    );
    expect(res.headers.get("location")).toBe("/settings/accounts?connected=gitlab");
    const [c] = await rows(userId);
    expect(c).toMatchObject({
      provider: "gitlab",
      host: "gitlab.com",
      login: "lab",
      email: "lab@x.io",
      scopes: "api read_user write_repository",
    });
    expect(decrypt(c!.refreshTokenEnc!, ENC)).toBe("gl_r");
    expect(c!.expiresAt!.getTime()).toBeGreaterThan(before + 7100_000);
    expect(c!.expiresAt!.getTime()).toBeLessThan(Date.now() + 7300_000);
  });

  it("reconnecting replaces the token, resets the error and keeps the uploaded key for the same account", async () => {
    process.env.GITHUB_CLIENT_ID = "sid";
    process.env.GITHUB_CLIENT_SECRET = "ssec";
    const { userId } = await setup();
    await upsertGitConnection(t.db, {
      userId,
      provider: "github",
      host: "github.com",
      method: "oauth",
      login: "octo",
      email: null,
      providerUserId: "42",
      token: "old",
      refreshToken: null,
      expiresAt: null,
      scopes: "repo",
      ip,
    });
    await t.db
      .update(gitConnections)
      .set({ sshKeyId: "k", status: "error", lastError: "x" })
      .where(eq(gitConnections.userId, userId));
    stubFetch((url) =>
      url.includes("access_token")
        ? Response.json({ access_token: "new", scope: "repo,write:public_key" })
        : Response.json({ id: 42, login: "octo" }),
    );
    await handleGitCallback("github", req("/api/auth/callback/github", "code=abc&state=st"));
    const all = await rows(userId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      sshKeyId: "k",
      status: "active",
      lastError: null,
      scopes: "repo,write:public_key",
    });
  });

  it("rejects a mismatched state, a denial and a failed exchange without storing anything", async () => {
    process.env.GITHUB_CLIENT_ID = "sid";
    process.env.GITHUB_CLIENT_SECRET = "ssec";
    const { userId } = await setup();
    const spy = stubFetch(() => undefined);
    expect(
      (await handleGitCallback("github", req("/cb", "code=abc&state=other"))).headers.get(
        "location",
      ),
    ).toBe("/onboarding?error=state");
    expect(
      (await handleGitCallback("github", req("/cb", "state=st"))).headers.get("location"),
    ).toBe("/onboarding?error=state");
    expect(
      (await handleGitCallback("github", req("/cb", "error=access_denied&state=st"))).headers.get(
        "location",
      ),
    ).toBe("/onboarding?error=denied");
    expect(spy).toHaveLength(0);
    stubFetch(() => Response.json({ error: "bad_verification_code" }, { status: 400 }));
    expect(
      (await handleGitCallback("github", req("/cb", "code=abc&state=st"))).headers.get("location"),
    ).toBe("/onboarding?error=exchange");
    expect(await rows(userId)).toHaveLength(0);
  });

  it("is a 404 for a provider the administrator did not configure and a login redirect without a session", async () => {
    const { userId } = await setup();
    expect((await handleGitCallback("bitbucket", req("/cb", "code=a&state=st"))).status).toBe(404);
    holder.session = null;
    expect(
      (await handleGitCallback("gitlab", req("/cb", "code=a&state=st"))).headers.get("location"),
    ).toBe("/login");
    expect(await rows(userId)).toHaveLength(0);
  });
});
