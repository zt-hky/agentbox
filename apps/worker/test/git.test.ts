import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@agentbox/core/tokens";
import { gitConnections, jobs, workspaces } from "@agentbox/db/schema";
import { reconcileGit, refreshGitTokens, startGitRefreshLoop } from "../src/git.ts";
import { createClock, makeCtx, testConfig } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { startFakeAgent, WORKSPACE_SSH_KEY, type FakeAgent } from "./helpers/fake-agent.ts";
import { ENC_KEY, seedWorld, type World } from "./helpers/seed.ts";

let t: TestDb;
let agent: FakeAgent;
const clock = createClock();
const PUT = "PUT /v1/workspaces/alice/git";

beforeAll(async () => {
  t = await createTestDb();
  agent = await startFakeAgent();
});
afterAll(async () => {
  await agent.close();
  await t.close();
});
beforeEach(async () => {
  clock.set(new Date("2026-03-10T12:00:00.000Z"));
  await resetDb(t.db);
  agent.calls.length = 0;
  agent.on(PUT, { json: { sshPublicKey: WORKSPACE_SSH_KEY } });
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (gitOAuth: typeof testConfig.gitOAuth = {}) => {
  const c = makeCtx(t.db, clock, { socketPath: agent.socketPath });
  return { ...c, config: { ...c.config, gitOAuth } };
};
const ws = async (id: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const conns = () => t.db.select().from(gitConnections).orderBy(gitConnections.createdAt);

let seq = 0;
async function connect(
  w: World,
  o: Partial<typeof gitConnections.$inferInsert> & { token?: string; refresh?: string },
) {
  seq++;
  const { token, refresh, ...rest } = o;
  const [row] = await t.db
    .insert(gitConnections)
    .values({
      userId: w.userId,
      provider: "github",
      host: "github.com",
      method: "oauth",
      login: "octo",
      tokenEnc: encrypt(token ?? "tok", ENC_KEY),
      refreshTokenEnc: refresh ? encrypt(refresh, ENC_KEY) : null,
      createdAt: new Date(clock.now().getTime() + seq),
      ...rest,
    })
    .returning();
  return row!;
}

/** Stub the provider APIs; records every call. */
function stubProviders(
  handler: (url: string, init: RequestInit) => Response | undefined = () => undefined,
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const raw = init.body as string | undefined;
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // form-encoded token requests stay a string
      }
      calls.push({ url, method, body });
      const custom = handler(url, init);
      if (custom) return custom;
      if (method === "GET" && url.includes("/keys")) return Response.json([]);
      if (method === "POST" && url.includes("/keys")) return Response.json({ id: 777 });
      return new Response(null, { status: 204 });
    }),
  );
  return calls;
}

describe("reconcileGit desired state", () => {
  it("sends every connection with credential usernames, scanned host keys and the preferred identity", async () => {
    const w = await seedWorld(t.db, { workspace: { sshPublicKey: WORKSPACE_SSH_KEY } });
    await connect(w, {
      provider: "gitlab",
      host: "gitlab.com",
      login: "lab",
      email: "7-lab@users.noreply.gitlab.com",
      token: "glt",
      sshKeyId: "1",
    });
    await connect(w, {
      login: "octo",
      email: "42+octo@users.noreply.github.com",
      token: "gho",
      scopes: "repo",
      sshKeyId: "2",
    });
    await connect(w, {
      provider: "gitea",
      host: "git.example.com",
      method: "token",
      login: "me",
      token: "gt",
      knownHosts: "git.example.com ssh-ed25519 AAAA",
      sshKeyId: "3",
    });
    await connect(w, {
      provider: "bitbucket",
      host: "bitbucket.org",
      login: "bb",
      token: "bbt",
      sshKeyId: "4",
    });
    stubProviders();
    await reconcileGit(ctx(), await ws(w.workspaceId));
    const [call] = agent.callsTo(PUT);
    expect(call!.body).toEqual({
      connections: [
        { provider: "gitlab", host: "gitlab.com", login: "lab", token: "glt", username: "oauth2" },
        { provider: "github", host: "github.com", login: "octo", token: "gho", username: "octo" },
        {
          provider: "gitea",
          host: "git.example.com",
          login: "me",
          token: "gt",
          username: "me",
          knownHosts: "git.example.com ssh-ed25519 AAAA",
        },
        {
          provider: "bitbucket",
          host: "bitbucket.org",
          login: "bb",
          token: "bbt",
          username: "x-token-auth",
        },
      ],
      identity: { name: "octo", email: "42+octo@users.noreply.github.com" },
    });
  });

  it("identity comes from the oldest account when GitHub is not linked, and is omitted without an email", async () => {
    const w = await seedWorld(t.db, { workspace: { sshPublicKey: WORKSPACE_SSH_KEY } });
    await connect(w, {
      provider: "gitlab",
      host: "gitlab.com",
      login: "lab",
      email: "7-lab@users.noreply.gitlab.com",
      sshKeyId: "1",
    });
    await connect(w, { provider: "bitbucket", host: "bitbucket.org", login: "bb", sshKeyId: "2" });
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect((agent.callsTo(PUT)[0]!.body as { identity: unknown }).identity).toEqual({
      name: "lab",
      email: "7-lab@users.noreply.gitlab.com",
    });
    await t.db.delete(gitConnections).where(eq(gitConnections.provider, "gitlab"));
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(agent.callsTo(PUT)[1]!.body).not.toHaveProperty("identity");
  });

  it("stores the public key the agent returns", async () => {
    const w = await seedWorld(t.db);
    expect((await ws(w.workspaceId)).sshPublicKey).toBeNull();
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect((await ws(w.workspaceId)).sshPublicKey).toBe(WORKSPACE_SSH_KEY);
  });

  it("a sleeping workspace only gets the pending flag", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(agent.calls).toHaveLength(0);
    expect((await ws(w.workspaceId)).gitSyncPending).toBe(true);
  });
});

describe("workspace SSH key upload", () => {
  it("uploads once per connection, stores the key id, and skips it on later syncs", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { scopes: "repo,write:public_key" });
    const calls = stubProviders();
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/user/keys?per_page=100",
      "POST https://api.github.com/user/keys",
    ]);
    expect(calls[1]!.body).toEqual({ key: WORKSPACE_SSH_KEY, title: "AgentBox alice" });
    expect((await conns())[0]!.sshKeyId).toBe("777");
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls).toHaveLength(2);
  });

  it("reuses a key that is already at the provider", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { scopes: "write:public_key" });
    const calls = stubProviders((url, init) =>
      !init.method && url.includes("/keys")
        ? Response.json([
            { id: 5, key: `${WORKSPACE_SSH_KEY.split(" ").slice(0, 2).join(" ")} old-comment` },
          ])
        : undefined,
    );
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect((await conns())[0]!.sshKeyId).toBe("5");
  });

  it("skips github tokens without write:public_key, generic hosts and errored connections", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { scopes: "repo,read:org,gist" });
    await connect(w, { provider: "generic", host: "code.example.org", method: "token" });
    await connect(w, { provider: "gitlab", host: "gitlab.com", status: "error" });
    const calls = stubProviders();
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls).toHaveLength(0);
    expect((await conns()).map((c) => c.sshKeyId)).toEqual([null, null, null]);
  });

  it("uploads to gitea with its token auth and bitbucket with the account uuid", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { provider: "gitea", host: "git.example.com", method: "token", token: "gt" });
    await connect(w, { provider: "bitbucket", host: "bitbucket.org", providerUserId: "{uuid-1}" });
    const headers: Record<string, unknown>[] = [];
    const calls = stubProviders((url, init) => {
      headers.push(init.headers as Record<string, unknown>);
      if (url.includes("bitbucket") && !init.method) return Response.json({ values: [] });
      if (url.includes("bitbucket") && init.method === "POST")
        return Response.json({ uuid: "{key-1}" });
      return undefined;
    });
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://git.example.com/api/v1/user/keys?per_page=100",
      "POST https://git.example.com/api/v1/user/keys",
      "GET https://api.bitbucket.org/2.0/users/%7Buuid-1%7D/ssh-keys?pagelen=100",
      "POST https://api.bitbucket.org/2.0/users/%7Buuid-1%7D/ssh-keys",
    ]);
    expect(headers[0]).toMatchObject({ Authorization: "token gt" });
    expect(calls[3]!.body).toEqual({ key: WORKSPACE_SSH_KEY, label: "AgentBox alice" });
    expect((await conns()).map((c) => c.sshKeyId)).toEqual(["777", "{key-1}"]);
  });

  it("a recreated workspace with a new key replaces the stale key at the provider", async () => {
    const w = await seedWorld(t.db, {
      workspace: { sshPublicKey: "ssh-ed25519 OLDKEYOLDKEY agentbox:alice" },
    });
    await connect(w, { scopes: "write:public_key", sshKeyId: "11" });
    const calls = stubProviders();
    await reconcileGit(ctx(), await ws(w.workspaceId));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE https://api.github.com/user/keys/11",
      "GET https://api.github.com/user/keys?per_page=100",
      "POST https://api.github.com/user/keys",
    ]);
    expect((await conns())[0]!.sshKeyId).toBe("777");
    expect((await ws(w.workspaceId)).sshPublicKey).toBe(WORKSPACE_SSH_KEY);
  });

  it("a provider rejection is recorded on the connection and does not fail the sync", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { scopes: "write:public_key" });
    stubProviders((url, init) =>
      init.method === "POST" ? new Response("{}", { status: 422 }) : undefined,
    );
    await reconcileGit(ctx(), await ws(w.workspaceId));
    const [c] = await conns();
    expect(c!.sshKeyId).toBeNull();
    expect(c!.lastError).toMatch(/SSH key upload failed.*422/);
    expect((await ws(w.workspaceId)).gitSyncPending).toBe(false);
  });

  it("a transient provider failure applies everything else, then fails the job so it retries", async () => {
    const w = await seedWorld(t.db);
    await connect(w, { scopes: "write:public_key" });
    stubProviders((url, init) =>
      init.method === "POST" ? new Response("{}", { status: 503 }) : undefined,
    );
    await expect(reconcileGit(ctx(), await ws(w.workspaceId))).rejects.toThrow(
      /github\.com.*retry/,
    );
    expect((await ws(w.workspaceId)).sshPublicKey).toBe(WORKSPACE_SSH_KEY);
    expect((await conns())[0]!.sshKeyId).toBeNull();
  });
});

describe("refreshGitTokens", () => {
  const GITLAB = { gitlab: { clientId: "gid", clientSecret: "gsec" } };
  const dueIn = (ms: number) => new Date(clock.now().getTime() + ms);
  const gitlab = (w: World, o: Partial<typeof gitConnections.$inferInsert> = {}) =>
    connect(w, {
      provider: "gitlab",
      host: "gitlab.com",
      login: "lab",
      token: "old-access",
      refresh: "old-refresh",
      expiresAt: dueIn(10 * 60_000),
      sshKeyId: "1",
      ...o,
    });
  const refreshResponse = () =>
    Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });

  it("refreshes tokens expiring within 30 minutes, rotates the refresh token and queues a sync", async () => {
    const w = await seedWorld(t.db);
    await gitlab(w);
    const calls = stubProviders(() => refreshResponse());
    expect(await refreshGitTokens(ctx(GITLAB))).toBe(1);
    const [c] = await conns();
    expect(decrypt(c!.tokenEnc, ENC_KEY)).toBe("new-access");
    expect(decrypt(c!.refreshTokenEnc!, ENC_KEY)).toBe("new-refresh");
    expect(c!.expiresAt!.getTime()).toBe(clock.now().getTime() + 7200 * 1000);
    expect(c!.status).toBe("active");
    expect(calls[0]!.url).toBe("https://gitlab.com/oauth/token");
    expect((await t.db.select().from(jobs)).map((j) => j.type)).toEqual(["sync_git"]);
  });

  it("leaves connections that are not due, token-based or already in error", async () => {
    const w = await seedWorld(t.db);
    await gitlab(w, { expiresAt: dueIn(3 * 3600_000) });
    await gitlab(w, {
      host: "gitlab.example.com",
      provider: "gitlab-self",
      method: "token",
      refreshTokenEnc: null,
      expiresAt: null,
    });
    await gitlab(w, { host: "gitlab.example.org", status: "error" });
    const calls = stubProviders(() => refreshResponse());
    expect(await refreshGitTokens(ctx(GITLAB))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("a sleeping workspace gets the pending flag instead of a job", async () => {
    const w = await seedWorld(t.db, { status: "sleeping" });
    await gitlab(w);
    stubProviders(() => refreshResponse());
    await refreshGitTokens(ctx(GITLAB));
    expect((await ws(w.workspaceId)).gitSyncPending).toBe(true);
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it("a rejected refresh marks the connection as error; a transient failure keeps it active", async () => {
    const w = await seedWorld(t.db);
    await gitlab(w);
    await gitlab(w, { provider: "bitbucket", host: "bitbucket.org", login: "bb" });
    stubProviders((url) =>
      url.includes("gitlab")
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("{}", { status: 502 }),
    );
    expect(
      await refreshGitTokens(ctx({ ...GITLAB, bitbucket: { clientId: "b", clientSecret: "s" } })),
    ).toBe(0);
    const rows = await conns();
    const lab = rows.find((c) => c.provider === "gitlab")!;
    const bb = rows.find((c) => c.provider === "bitbucket")!;
    expect(lab.status).toBe("error");
    expect(lab.lastError).toMatch(/invalid_grant/);
    expect(decrypt(lab.tokenEnc, ENC_KEY)).toBe("old-access");
    expect(bb.status).toBe("active");
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it("skips providers whose OAuth client is not configured", async () => {
    const w = await seedWorld(t.db);
    await gitlab(w);
    const calls = stubProviders();
    expect(await refreshGitTokens(ctx({}))).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await conns())[0]!.status).toBe("active");
  });

  it("the loop runs on its schedule and stops", async () => {
    const w = await seedWorld(t.db);
    await gitlab(w);
    stubProviders(() => refreshResponse());
    const stop = startGitRefreshLoop(ctx(GITLAB), { firstRunMs: 1, intervalMs: 60_000 });
    await vi.waitFor(async () => {
      expect(decrypt((await conns())[0]!.tokenEnc, ENC_KEY)).toBe("new-access");
    });
    stop();
  });
});
