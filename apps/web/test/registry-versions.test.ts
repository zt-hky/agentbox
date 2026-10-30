import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { REGISTRY, registryVersionSource, type FetchLike } from "@agentbox/core/toolchain";
import { toolLatest } from "@agentbox/db/schema";
import { loadRegistryVersions } from "../lib/toolchain/registry-versions";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ tag_name: `v2.${i}.0` }));
const counting = (body: unknown, ok = true) => {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return { ok, status: ok ? 200 : 503, json: async () => body, text: async () => "" };
  };
  return { urls, fetchImpl };
};
const hourMs = 60 * 60_000;

describe("loadRegistryVersions", () => {
  const id = "mise:ripgrep";
  const t0 = new Date("2026-01-01T00:00:00Z");

  it("fetches once, caches in tool_latest (max 50, newest first) and refetches only when stale", async () => {
    const f = counting(tags(80));
    const first = await loadRegistryVersions(t.db, id, { fetchImpl: f.fetchImpl, now: t0 });
    expect(first).toHaveLength(50);
    expect(first[0]).toBe("2.79.0");
    expect(f.urls).toHaveLength(1);
    const [row] = await t.db.select().from(toolLatest).where(eq(toolLatest.toolId, id));
    expect(row?.versions).toEqual(first);
    expect(row?.checkedAt?.getTime()).toBe(t0.getTime());

    const soon = new Date(t0.getTime() + hourMs - 1000);
    expect(await loadRegistryVersions(t.db, id, { fetchImpl: f.fetchImpl, now: soon })).toEqual(
      first,
    );
    expect(f.urls).toHaveLength(1);

    const g = counting(tags(3));
    const later = new Date(t0.getTime() + hourMs + 1000);
    expect(await loadRegistryVersions(t.db, id, { fetchImpl: g.fetchImpl, now: later })).toEqual([
      "2.2.0",
      "2.1.0",
      "2.0.0",
    ]);
    expect(g.urls).toHaveLength(1);
  });

  it("returns an empty list on a network failure with nothing cached, and keeps stale data otherwise", async () => {
    const other = "mise:fd";
    const bad = counting(null, false);
    expect(await loadRegistryVersions(t.db, other, { fetchImpl: bad.fetchImpl, now: t0 })).toEqual(
      [],
    );
    const [row] = await t.db.select().from(toolLatest).where(eq(toolLatest.toolId, other));
    expect(row?.error).toMatch(/HTTP 503/);

    // a failure right after is not retried
    const again = counting(tags(2));
    expect(
      await loadRegistryVersions(t.db, other, { fetchImpl: again.fetchImpl, now: t0 }),
    ).toEqual([]);
    expect(again.urls).toHaveLength(0);

    // stale cached data survives a failed refresh
    const stale = "mise:bat";
    const ok = counting(tags(2));
    await loadRegistryVersions(t.db, stale, { fetchImpl: ok.fetchImpl, now: t0 });
    const down = counting(null, false);
    const later = new Date(t0.getTime() + 3 * hourMs);
    expect(
      await loadRegistryVersions(t.db, stale, { fetchImpl: down.fetchImpl, now: later }),
    ).toEqual(["2.1.0", "2.0.0"]);
  });

  it("returns nothing, without fetching, for a tool with no version source", async () => {
    const none = REGISTRY.find((r) => !registryVersionSource(`mise:${r.name}`));
    const f = counting(tags(2));
    expect(
      await loadRegistryVersions(t.db, `mise:${none!.name}`, { fetchImpl: f.fetchImpl, now: t0 }),
    ).toEqual([]);
    expect(f.urls).toHaveLength(0);
  });
});
