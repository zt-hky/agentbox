import { describe, expect, it } from "vitest";
import { wsSlugSchema, imageIdSchema, jobIdSchema, logQuerySchema } from "@agentbox/core/agent-api";
import { checkBearer } from "../src/auth.ts";
import { parseExtraBlocked, parseTraceIp } from "../src/firewall.ts";
import { isPlainArg, isTenantUid, lastLines, slotOfUid } from "../src/safe.ts";
import { routes } from "../src/server.ts";

describe("checkBearer", () => {
  const token = "s3cret-token-value-0123456789";
  it("accepts only the exact bearer token", () => {
    expect(checkBearer(`Bearer ${token}`, token)).toBe(true);
    expect(checkBearer(`Bearer ${token}x`, token)).toBe(false);
    expect(checkBearer(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
    expect(checkBearer(token, token)).toBe(false);
    expect(checkBearer(`bearer ${token}`, token)).toBe(false);
    expect(checkBearer(undefined, token)).toBe(false);
    expect(checkBearer(["Bearer a"], token)).toBe(false);
    expect(checkBearer("Bearer ", token)).toBe(false);
  });
  it("never authenticates against an empty server token", () => {
    expect(checkBearer("Bearer ", "")).toBe(false);
    expect(checkBearer("Bearer x", "")).toBe(false);
  });
});

describe("param validation", () => {
  it("rejects path-injection in workspace, image and job ids", () => {
    for (const bad of ["../etc", "a/b", "ab", "Alice", "9abc", "a".repeat(21), "ab c", "abc;rm"]) {
      expect(wsSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(wsSlugSchema.safeParse("alice").success).toBe(true);
    expect(imageIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(imageIdSchema.safeParse("../".repeat(22)).success).toBe(false);
    expect(imageIdSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(jobIdSchema.safeParse("job-1_a").success).toBe(true);
    expect(jobIdSchema.safeParse("../x").success).toBe(false);
    expect(jobIdSchema.safeParse("-rf").success).toBe(false);
    expect(logQuerySchema.parse({}).tail).toBe(200);
    expect(logQuerySchema.safeParse({ tail: "0" }).success).toBe(false);
  });

  it("classifies tenant uids and arguments", () => {
    expect(isTenantUid(200001)).toBe(true);
    expect(isTenantUid(204999)).toBe(true);
    expect(isTenantUid(200000)).toBe(false);
    expect(isTenantUid(205000)).toBe(false);
    expect(slotOfUid(204998)).toBe(4998);
    expect(isPlainArg("alice")).toBe(true);
    expect(isPlainArg("--system")).toBe(false);
    expect(isPlainArg("a\nb")).toBe(false);
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
  });

  it("routes cover every endpoint exactly once", () => {
    const keys = routes.map((r) => `${r.method} ${r.pattern.source}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(23);
  });
});

describe("firewall parsing", () => {
  it("extracts ipv4 from cloudflare trace", () => {
    expect(parseTraceIp("fl=1\nip=203.0.113.7\nts=1\n")).toBe("203.0.113.7");
    expect(parseTraceIp("ip=2606:4700::1\n")).toBeNull();
    expect(parseTraceIp("ip=999.1.1.1\n")).toBeNull();
    expect(parseTraceIp("nothing")).toBeNull();
  });
  it("parses extra-blocked.conf", () => {
    const r = parseExtraBlocked("# c\n\n10.1.0.0/16  # note\n1.2.3.4\nbad/33\n; x\n");
    expect(r.valid).toEqual(["10.1.0.0/16", "1.2.3.4"]);
    expect(r.invalid).toEqual(["bad/33", "; x"]);
  });
});
