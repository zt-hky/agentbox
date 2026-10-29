import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hashToken, randomToken } from "../src/tokens.ts";

const key = randomBytes(32).toString("base64");

describe("tokens", () => {
  it("randomToken is 32 bytes base64url and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  const hashes: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ];
  it.each(hashes)("hashToken(%j)", (t, h) => expect(hashToken(t)).toBe(h));

  it.each(["", "hello", "ünïcödé 🚀", "x".repeat(10_000)])("roundtrip %#", (pt) => {
    const c = encrypt(pt, key);
    expect(c).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decrypt(c, key)).toBe(pt);
  });
  it("uses a fresh IV", () => {
    expect(encrypt("a", key)).not.toBe(encrypt("a", key));
  });
  it("rejects tampering, wrong key, bad format, bad key size", () => {
    const c = encrypt("secret", key);
    const [v, iv, ct] = c.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0]! ^= 1;
    expect(() => decrypt(`${v}.${iv}.${flipped.toString("base64url")}`, key)).toThrow();
    expect(() => decrypt(c, randomBytes(32).toString("base64"))).toThrow();
    expect(() => decrypt("v2.a.b", key)).toThrow();
    expect(() => decrypt("garbage", key)).toThrow();
    expect(() => encrypt("x", randomBytes(16).toString("base64"))).toThrow();
  });
});
