import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FetchLike } from "@agentbox/core/toolchain";
import { toolLatest } from "@agentbox/db/schema";
import { upsertToolLatest } from "@agentbox/db/toolchain";
import { refreshToolLatest, startLatestLoop } from "../src/latest.ts";
import { createClock, makeCtx } from "./helpers/ctx.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

let t: TestDb;
const clock = createClock();
const ctx = () => makeCtx(t.db, clock);

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.delete(toolLatest);
});

const res = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

/** Every published source, answering with a small valid document. */
function fakeFetch(state: { fail: boolean; calls: string[] }): FetchLike {
  return async (url) => {
    state.calls.push(url);
    if (state.fail) throw new Error("network down");
    if (url.includes("nodejs.org"))
      return res([
        { version: "v26.13.0", lts: false },
        { version: "v24.22.2", lts: "Krypton" },
      ]);
    if (url.includes("mise-versions")) return res("3.12.16\n3.13.1\n");
    if (url.includes("go.dev/dl"))
      return res([
        { version: "go1.24.1", stable: true },
        { version: "go1.25rc1", stable: false },
      ]);
    if (url.includes("api.adoptium.net"))
      return res({
        versions: [
          { major: 26, minor: 0, security: 1, openjdk_version: "26.0.1+9" },
          { major: 25, minor: 0, security: 2, openjdk_version: "25.0.2+10-LTS" },
          { major: 21, minor: 0, security: 9, openjdk_version: "21.0.9+10-LTS" },
        ],
      });
    if (url.includes("api.github.com/repos/"))
      return res([
        { tag_name: "1.91.0", prerelease: false },
        { tag_name: "1.90.0", prerelease: false },
      ]);
    if (url.includes("pypi.org/pypi/")) return res({ releases: { "2.2.1": [{}], "2.1.4": [{}] } });
    if (url.includes("repo1.maven.org"))
      return res("<versions><version>3.9.10</version><version>3.9.11</version></versions>");
    if (url.includes("registry.npmjs.org"))
      return res({ "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": {}, "1.1.0": {} } });
    if (url.includes("muse-code/channels"))
      return res({ version: "1.4.14", manifest_url: "https://m.test/manifest" });
    return res({
      version: "1.4.14",
      artifacts: { x86_linux: { url: "https://m.test/muse", checksum: "ab".repeat(32) } },
    });
  };
}

const row = async (id: string) =>
  (await t.db.select().from(toolLatest).where(eq(toolLatest.toolId, id)))[0];

describe("upsertToolLatest", () => {
  it("stores a fetched row and clears an earlier error", async () => {
    const now = new Date("2026-03-10T12:00:00Z");
    await upsertToolLatest(t.db, "bun", { error: "first" });
    await upsertToolLatest(
      t.db,
      "bun",
      { info: { latest: "1.3.4", lts: null, versions: ["1.3.4", "1.3.3"], meta: { a: "b" } } },
      now,
    );
    expect(await row("bun")).toMatchObject({
      latest: "1.3.4",
      lts: null,
      versions: ["1.3.4", "1.3.3"],
      meta: { a: "b" },
      checkedAt: now,
      error: null,
    });
  });

  it("keeps the previous good data when a later fetch fails", async () => {
    const now = new Date("2026-03-10T12:00:00Z");
    await upsertToolLatest(
      t.db,
      "bun",
      { info: { latest: "1.3.4", lts: null, versions: ["1.3.4"] } },
      now,
    );
    await upsertToolLatest(t.db, "bun", { error: "HTTP 503" }, new Date("2026-03-10T13:00:00Z"));
    expect(await row("bun")).toMatchObject({
      latest: "1.3.4",
      versions: ["1.3.4"],
      checkedAt: now,
      error: "HTTP 503",
    });
  });

  it("records an error for a tool never fetched", async () => {
    await upsertToolLatest(t.db, "grok", { error: "boom" });
    expect(await row("grok")).toMatchObject({
      latest: null,
      versions: [],
      checkedAt: null,
      error: "boom",
    });
  });
});

describe("refreshToolLatest", () => {
  it("fetches every catalog entry", async () => {
    const state = { fail: false, calls: [] as string[] };
    const failed = await refreshToolLatest(ctx(), undefined, fakeFetch(state));
    expect(failed).toEqual([]);
    expect(await row("node")).toMatchObject({ latest: "26.13.0", lts: "24.22.2", error: null });
    expect(await row("python")).toMatchObject({ latest: "3.13.1" });
    expect(await row("go")).toMatchObject({ latest: "1.24.1", versions: ["1.24.1"] });
    expect(await row("rust")).toMatchObject({ latest: "1.91.0", versions: ["1.91.0", "1.90.0"] });
    expect(await row("java")).toMatchObject({ latest: "26.0.1", lts: "25.0.2" });
    expect(await row("bun")).toMatchObject({ latest: "1.1.0", versions: ["1.1.0", "1.0.0"] });
    expect(await row("muse")).toMatchObject({ latest: "1.4.14" });
    expect((await row("muse"))!.meta).toMatchObject({ url: "https://m.test/muse" });
    expect(await row("poetry")).toMatchObject({ latest: "2.2.1", versions: ["2.2.1", "2.1.4"] });
    expect(await row("maven")).toMatchObject({ latest: "3.9.11", versions: ["3.9.11", "3.9.10"] });
    expect(await row("uv")).toMatchObject({ latest: "1.91.0" });
    expect(await row("pnpm")).toMatchObject({ latest: "1.1.0" });
  });

  it("refreshes only the requested tools and keeps old data on failure", async () => {
    const state = { fail: false, calls: [] as string[] };
    await refreshToolLatest(ctx(), ["node"], fakeFetch(state));
    expect(state.calls.every((u) => u.includes("nodejs.org"))).toBe(true);
    expect(await row("bun")).toBeUndefined();

    state.fail = true;
    const failed = await refreshToolLatest(ctx(), ["node"], fakeFetch(state));
    expect(failed).toEqual(["node"]);
    expect(await row("node")).toMatchObject({ latest: "26.13.0", error: "network down" });
  });
});

describe("startLatestLoop", () => {
  it("refreshes shortly after boot, retries after the negative TTL and stops", async () => {
    const state = { fail: true, calls: [] as string[] };
    const stop = startLatestLoop(ctx(), {
      fetch: fakeFetch(state),
      firstRunMs: 1,
      negativeTtlMs: 20,
      intervalMs: 60_000,
    });
    await expect.poll(() => state.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    const failedCalls = state.calls.length;
    state.fail = false;
    await expect.poll(async () => (await row("node"))?.latest, { timeout: 5000 }).toBe("26.13.0");
    expect(state.calls.length).toBeGreaterThan(failedCalls);
    expect((await row("node"))!.error).toBeNull();
    stop();
    // A refresh already in flight may finish; after it, nothing new is scheduled. A real wait is
    // needed because the assertion is that no timer fires.
    const sample = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return state.calls.length;
    };
    let settled = await sample();
    for (let again = await sample(); again !== settled; again = await sample()) settled = again;
    expect(await sample()).toBe(settled);
  });
});
