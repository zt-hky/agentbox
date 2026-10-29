import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hashToken, randomToken, signGatewayIdentity } from "@agentbox/core";
import {
  handoffCodes,
  hostStats,
  jobs,
  user,
  workspaceSessions,
  workspaces,
} from "@agentbox/db/schema";
import { createGateway, safeReturnPath } from "../src/gateway.ts";
import { esc } from "../src/html.ts";
import { BASE_DOMAIN, createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, resetDb, type TestDb } from "./helpers/db.ts";
import { listen, request } from "./helpers/http.ts";
import { seedWorld, type World } from "./helpers/seed.ts";

const D = BASE_DOMAIN;
const T3 = `alice-t3.${D}`;
const CODE = `alice-code.${D}`;
const NAV = { "sec-fetch-mode": "navigate" };

let t: TestDb;
let srv: Awaited<ReturnType<typeof listen>>;
const clock = createClock();

beforeAll(async () => {
  t = await createTestDb();
  srv = await listen(createGateway(makeCtx(t.db, clock)));
});
afterAll(async () => {
  await srv.close();
  await t.close();
});
beforeEach(async () => {
  clock.set(new Date("2026-03-10T12:00:00.000Z"));
  await resetDb(t.db);
});

async function session(
  w: World,
  host: string,
  over: Partial<typeof workspaceSessions.$inferInsert> = {},
) {
  const token = randomToken();
  await t.db.insert(workspaceSessions).values({
    tokenHash: hashToken(token),
    userId: w.userId,
    workspaceId: w.workspaceId,
    host,
    expiresAt: new Date(clock.now().getTime() + 3600_000),
    ...over,
  });
  return { cookie: `__Host-abx_ws=${token}` };
}
const get = (path: string, headers: Record<string, string>) => request(srv.port, path, headers);
const startJobs = () => t.db.select().from(jobs).where(eq(jobs.type, "start_workspace"));

describe("authorize: routing and unauthenticated", () => {
  it("404s reserved labels, unknown services and non-workspace hosts; ignores X-Forwarded-Host", async () => {
    await seedWorld(t.db);
    for (const host of [
      `admin-t3.${D}`,
      `alice-term.${D}`,
      `app.${D}`,
      `alice-t3.evil.com`,
      `a.b-t3.${D}`,
    ]) {
      expect((await get("/internal/authorize", { host, ...NAV })).status, host).toBe(404);
    }
    const r = await get("/internal/authorize", {
      host: `app.${D}`,
      "x-forwarded-host": T3,
      ...NAV,
    });
    expect(r.status).toBe(404);
    expect((await get("/nope", { host: T3 })).status).toBe(404);
  });

  it("navigation without cookie redirects to the handoff URL carrying the return path", async () => {
    await seedWorld(t.db);
    const r = await get("/internal/authorize", { host: T3, ...NAV, "x-forwarded-uri": "/foo?a=1" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`https://app.${D}/auth/handoff?host=${T3}&path=%2Ffoo%3Fa%3D1`);
    // GET + Accept text/html counts as navigation; hostile return path is neutralised.
    const r2 = await get("/internal/authorize", {
      host: T3,
      accept: "text/html,*/*",
      "x-forwarded-uri": "//evil.com",
    });
    expect(r2.headers.location).toBe(`https://app.${D}/auth/handoff?host=${T3}&path=%2F`);
  });

  it("non-navigation requests get 401, including non-GET forwarded methods", async () => {
    await seedWorld(t.db);
    expect((await get("/internal/authorize", { host: T3 })).status).toBe(401);
    expect(
      (
        await get("/internal/authorize", {
          host: T3,
          accept: "text/html",
          "x-forwarded-method": "POST",
        })
      ).status,
    ).toBe(401);
  });

  it("rejects a session minted for another host, another workspace, revoked, expired, or suspended user", async () => {
    const alice = await seedWorld(t.db);
    const bob = await seedWorld(t.db, { slug: "bobby", slot: 2 });
    const other = await session(alice, CODE);
    expect((await get("/internal/authorize", { host: T3, cookie: other.cookie })).status).toBe(401);
    const bobs = await session(bob, `bobby-t3.${D}`);
    expect((await get("/internal/authorize", { host: T3, cookie: bobs.cookie })).status).toBe(401);
    const revoked = await session(alice, T3, { revokedAt: clock.now() });
    expect((await get("/internal/authorize", { host: T3, cookie: revoked.cookie })).status).toBe(
      401,
    );
    const expired = await session(alice, T3, { expiresAt: new Date(clock.now().getTime() - 1) });
    expect((await get("/internal/authorize", { host: T3, cookie: expired.cookie })).status).toBe(
      401,
    );
    const ok = await session(alice, T3);
    expect((await get("/internal/authorize", { host: T3, cookie: ok.cookie })).status).toBe(200);
    await t.db.update(user).set({ accessStatus: "suspended" }).where(eq(user.id, alice.userId));
    clock.advance(31_000); // past the 30 s session cache
    expect((await get("/internal/authorize", { host: T3, cookie: ok.cookie })).status).toBe(401);
  });

  it("revocation takes effect after the 30 s cache window, not before", async () => {
    const w = await seedWorld(t.db);
    const s = await session(w, T3);
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie })).status).toBe(200);
    await t.db.update(workspaceSessions).set({ revokedAt: clock.now() });
    clock.advance(29_000);
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie })).status).toBe(200);
    clock.advance(2_000);
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie })).status).toBe(401);
  });
});

describe("authorize: running workspace", () => {
  it("returns the upstream and a verifiable identity token for t3, none for code", async () => {
    const w = await seedWorld(t.db, { slot: 3 });
    const s3 = await session(w, T3);
    const sc = await session(w, CODE);
    const r = await get("/internal/authorize", { host: T3, cookie: s3.cookie });
    expect(r.status).toBe(200);
    expect(r.headers["x-agentbox-upstream"]).toBe("127.0.0.1:20006");
    const token = r.headers["x-gateway-identity"] as string;
    const [h, p, sig] = token.split(".") as [string, string, string];
    expect(
      createHmac("sha256", Buffer.from(w.secret, "base64url"))
        .update(`${h}.${p}`)
        .digest("base64url"),
    ).toBe(sig);
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "agentbox", aud: "alice", sub: w.userId, email: w.email });
    expect(token).toBe(
      signGatewayIdentity({
        secret: w.secret,
        audience: "alice",
        sub: w.userId,
        email: w.email,
        nowSeconds: Math.floor(clock.now().getTime() / 1000),
      }),
    );

    const rc = await get("/internal/authorize", { host: CODE, cookie: sc.cookie });
    expect(rc.status).toBe(200);
    expect(rc.headers["x-agentbox-upstream"]).toBe("127.0.0.1:20007");
    expect(rc.headers["x-gateway-identity"]).toBeUndefined();
  });

  it("writes lastRequestAt/lastActivityAt at most once per 30 s", async () => {
    const w = await seedWorld(t.db);
    const s = await session(w, T3);
    const read = async () =>
      (await t.db.select().from(workspaces).where(eq(workspaces.id, w.workspaceId)))[0]!;
    await get("/internal/authorize", { host: T3, cookie: s.cookie });
    const first = (await read()).lastRequestAt!;
    expect(first.getTime()).toBe(clock.now().getTime());
    clock.advance(10_000);
    await get("/internal/authorize", { host: T3, cookie: s.cookie });
    expect((await read()).lastRequestAt!.getTime()).toBe(first.getTime());
    clock.advance(21_000);
    await get("/internal/authorize", { host: T3, cookie: s.cookie });
    expect((await read()).lastRequestAt!.getTime()).toBe(clock.now().getTime());
    expect((await read()).lastActivityAt!.getTime()).toBe(clock.now().getTime());
  });
});

describe("authorize: not running", () => {
  it("sleeping enqueues exactly one start job and answers 503 waking", async () => {
    const w = await seedWorld(t.db, { status: "sleeping", balance: 1_000_000n });
    const s = await session(w, T3);
    const r = await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV });
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("3");
    expect(r.body).toContain('<meta http-equiv="refresh" content="3">');
    expect(r.body).toContain('class="spin"');
    expect(r.body).not.toContain("<script");
    const api = await get("/internal/authorize", { host: T3, cookie: s.cookie });
    expect(api.status).toBe(503);
    expect(JSON.parse(api.body)).toEqual({ status: "waking" });
    const rows = await startJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: w.workspaceId, status: "queued" });
  });

  it("starting/provisioning show the waking page without enqueueing", async () => {
    const w = await seedWorld(t.db, { status: "starting" });
    const s = await session(w, T3);
    const r = await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV });
    expect(r.status).toBe(503);
    expect(r.body).toContain('http-equiv="refresh"');
    expect(await startJobs()).toHaveLength(0);
  });

  it("answers 402 when the balance is empty and the allowance is exhausted", async () => {
    const w = await seedWorld(t.db, {
      status: "sleeping",
      balance: 0n,
      subscription: { usedRuntimeHours: 1000, usedCpuCoreHours: 1000, usedMemGbHours: 1000 },
    });
    const s = await session(w, T3);
    const r = await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV });
    expect(r.status).toBe(402);
    expect(r.body).toContain("Workspace paused: out of credits");
    expect(r.body).toContain(`https://app.${D}/billing`);
    expect(await startJobs()).toHaveLength(0);
  });

  it("a positive balance lets an exhausted allowance start", async () => {
    const w = await seedWorld(t.db, {
      status: "sleeping",
      balance: 1n,
      subscription: { usedRuntimeHours: 1000, usedCpuCoreHours: 1000, usedMemGbHours: 1000 },
    });
    const s = await session(w, T3);
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV })).status).toBe(
      503,
    );
    expect(await startJobs()).toHaveLength(1);
  });

  it("answers 503 Retry-After 30 when running memory + this plan exceeds the ratio", async () => {
    const bob = await seedWorld(t.db, { slug: "bobby", slot: 2, status: "running" }); // Free: 4096 MB
    expect(bob.slug).toBe("bobby");
    const w = await seedWorld(t.db, { status: "sleeping" }); // Free: 4096 MB
    const s = await session(w, T3);
    const mem = (mb: number) => ({ host: { memTotalBytes: mb * 1024 * 1024 } });
    // limit = 0.8 * 10000 MB = 8000 MB < 4096 + 4096 = 8192
    await t.db.insert(hostStats).values({ id: 1, payload: mem(10_000) });
    const r = await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV });
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("30");
    expect(r.body).toContain("Server at capacity");
    expect(await startJobs()).toHaveLength(0);
    // 8192 <= 0.8 * 11000 = 8800 → fits
    await t.db.update(hostStats).set({ payload: mem(11_000) });
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV })).status).toBe(
      503,
    );
    expect(await startJobs()).toHaveLength(1);
  });

  it("startFailures >= 3 shows the failed page with a retry link and does not enqueue", async () => {
    const w = await seedWorld(t.db, { status: "error", workspace: { startFailures: 3 } });
    const s = await session(w, T3);
    const r = await get("/internal/authorize", { host: T3, cookie: s.cookie, ...NAV });
    expect(r.status).toBe(503);
    expect(r.body).toContain("Workspace failed to start");
    expect(r.body).toContain('href="/__abx/retry"');
    expect(r.body).not.toContain('http-equiv="refresh"');
    expect(await startJobs()).toHaveLength(0);

    const retry = await get("/__abx/retry", { host: T3, cookie: s.cookie, ...NAV });
    expect(retry.status).toBe(302);
    expect(retry.headers.location).toBe("/");
    const [row] = await t.db.select().from(workspaces).where(eq(workspaces.id, w.workspaceId));
    expect(row!.startFailures).toBe(0);
    expect(await startJobs()).toHaveLength(1);
  });

  it("retry without a session is rejected like authorize", async () => {
    await seedWorld(t.db, { status: "error", workspace: { startFailures: 3 } });
    const r = await get("/__abx/retry", { host: T3, ...NAV });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/auth/handoff?");
    expect(await startJobs()).toHaveLength(0);
  });
});

describe("handoff callback", () => {
  async function code(w: World, o: Partial<typeof handoffCodes.$inferInsert> = {}) {
    const c = randomToken();
    await t.db.insert(handoffCodes).values({
      codeHash: hashToken(c),
      userId: w.userId,
      workspaceId: w.workspaceId,
      host: T3,
      returnPath: "/foo/bar?x=1",
      expiresAt: new Date(clock.now().getTime() + 60_000),
      ...o,
    });
    return c;
  }

  it("is single use, sets the exact cookie, stores a hashed 7-day session and redirects", async () => {
    const w = await seedWorld(t.db);
    const c = await code(w);
    const r = await get(`/__abx/callback?code=${c}`, { host: T3 });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/foo/bar?x=1");
    const setCookie = r.headers["set-cookie"]![0]!;
    const m =
      /^__Host-abx_ws=([A-Za-z0-9_-]+); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800$/.exec(
        setCookie,
      );
    expect(m).not.toBeNull();
    const [sess] = await t.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.tokenHash, hashToken(m![1]!)));
    expect(sess).toMatchObject({ userId: w.userId, workspaceId: w.workspaceId, host: T3 });
    expect(sess!.expiresAt.getTime()).toBe(clock.now().getTime() + 7 * 86400_000);
    // The new cookie works immediately.
    expect(
      (await get("/internal/authorize", { host: T3, cookie: `__Host-abx_ws=${m![1]}` })).status,
    ).toBe(200);

    const again = await get(`/__abx/callback?code=${c}`, { host: T3 });
    expect(again.status).toBe(400);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("concurrent redemption of one code yields exactly one session", async () => {
    const w = await seedWorld(t.db);
    const c = await code(w);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => get(`/__abx/callback?code=${c}`, { host: T3 })),
    );
    expect(rs.filter((r) => r.status === 302)).toHaveLength(1);
    expect(await t.db.select().from(workspaceSessions)).toHaveLength(1);
  });

  it("rejects expired codes and host mismatches without consuming the code on mismatch", async () => {
    const w = await seedWorld(t.db);
    const expired = await code(w, { expiresAt: new Date(clock.now().getTime() - 1) });
    expect((await get(`/__abx/callback?code=${expired}`, { host: T3 })).status).toBe(400);

    const c = await code(w);
    expect((await get(`/__abx/callback?code=${c}`, { host: CODE })).status).toBe(400);
    expect((await get(`/__abx/callback?code=nope`, { host: T3 })).status).toBe(400);
    expect((await get(`/__abx/callback`, { host: T3 })).status).toBe(400);
    expect(await t.db.select().from(workspaceSessions)).toHaveLength(0);
    expect((await get(`/__abx/callback?code=${c}`, { host: T3 })).status).toBe(302);
  });

  it("neutralises open-redirect return paths", async () => {
    const w = await seedWorld(t.db);
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", ""]) {
      const c = await code(w, { returnPath: bad });
      const r = await get(`/__abx/callback?code=${c}`, { host: T3 });
      expect(r.headers.location, JSON.stringify(bad)).toBe("/");
    }
    expect(safeReturnPath("/ok?x=1")).toBe("/ok?x=1");
  });

  it("refuses codes for suspended users", async () => {
    const w = await seedWorld(t.db, { access: "suspended" });
    const c = await code(w);
    expect((await get(`/__abx/callback?code=${c}`, { host: T3 })).status).toBe(400);
  });
});

describe("logout", () => {
  it("revokes the session at once, clears the cookie and redirects to the app", async () => {
    const w = await seedWorld(t.db);
    const s = await session(w, T3);
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie })).status).toBe(200);
    const r = await get("/__abx/logout", { host: T3, cookie: s.cookie });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`https://app.${D}/`);
    expect(r.headers["set-cookie"]![0]).toBe(
      "__Host-abx_ws=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    const [row] = await t.db.select().from(workspaceSessions);
    expect(row!.revokedAt).not.toBeNull();
    // Cache was evicted: no 30 s grace after logout on this worker.
    expect((await get("/internal/authorize", { host: T3, cookie: s.cookie })).status).toBe(401);
  });
});

describe("html escaping", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
