import { describe, expect, it } from "vitest";
import { checkSlug, slugFromEmail } from "../lib/slug";

describe("slugFromEmail", () => {
  it.each([
    ["alice@example.com", "alice"],
    ["Alice.Smith+tag@example.com", "alicesmithtag"],
    ["a@example.com", "a00"],
    ["ab@example.com", "ab0"],
    ["123abc@example.com", "u123abc"],
    ["1@example.com", "u10"],
    ["...@example.com", "u00"],
    ["averyveryverylongemailaddress@example.com", "averyveryverylongema"],
    ["x-y_z@example.com", "xyz"],
  ])("%s -> %s", (email, expected) => {
    expect(slugFromEmail(email)).toBe(expected);
  });

  it("always produces a syntactically valid slug", async () => {
    for (const e of ["9@x.io", "_@x.io", "@x.io", "UPPER@x.io", "ü@x.io"]) {
      const r = await checkSlug(slugFromEmail(e), async () => false);
      // reserved words (e.g. "api") are rejected separately; none of these inputs hit them
      expect(r, e).toEqual({ ok: true });
    }
  });
});

describe("checkSlug", () => {
  const free = async () => false;
  it("accepts valid slugs", async () => {
    expect(await checkSlug("alice", free)).toEqual({ ok: true });
    expect(await checkSlug("a1b", free)).toEqual({ ok: true });
    expect(await checkSlug("a".repeat(20), free)).toEqual({ ok: true });
  });
  it.each(["ab", "a".repeat(21), "1abc", "ab-c", "Abc", "ab_c", "ab.c", ""])(
    "rejects invalid %j",
    async (s) => {
      const r = await checkSlug(s, free);
      expect(r.ok).toBe(false);
    },
  );
  it.each([
    "app",
    "api",
    "admin",
    "auth",
    "www",
    "docs",
    "status",
    "mail",
    "static",
    "assets",
    "cdn",
    "internal",
    "gateway",
    "registry",
  ])("rejects reserved %s", async (s) => {
    const r = await checkSlug(s, free);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("reserved") });
  });
  it("rejects taken slugs", async () => {
    const r = await checkSlug("alice", async (s) => s === "alice");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("already taken") });
  });
});
