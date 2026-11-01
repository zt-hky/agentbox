import { describe, expect, it } from "vitest";
import {
  RESERVED_LABELS,
  SERVICES,
  isValidWorkspaceSlug,
  parseWorkspaceHost,
  workspaceUrl,
} from "../src/hosts.ts";

const D = "agentbox.io.vn";

describe("parseWorkspaceHost", () => {
  const rows: [string, { ws: string; svc: string } | null][] = [
    ["alice-kcode.agentbox.io.vn", { ws: "alice", svc: "t3" }],
    ["alice-code.agentbox.io.vn", { ws: "alice", svc: "code" }],
    ["ALICE-KCODE.AgentBox.io.vn:8480", { ws: "alice", svc: "t3" }],
    ["alice-t3.agentbox.io.vn", null],
    ["app-kcode.agentbox.io.vn", null],
    ["a.b-kcode.agentbox.io.vn", null],
    ["alice-p5173.agentbox.io.vn", null],
    ["alice-term.agentbox.io.vn", null],
    ["alice.agentbox.io.vn", null],
    ["alice-kcode.example.com", null],
    ["alice-kcode.agentbox.io.vn.evil.com", null],
    ["agentbox.io.vn", null],
    ["-kcode.agentbox.io.vn", null],
    ["al-kcode.agentbox.io.vn", null],
    ["a-b-kcode.agentbox.io.vn", null],
    ["1alice-kcode.agentbox.io.vn", null],
    ["alice-constructor.agentbox.io.vn", null],
    ["alice-__proto__.agentbox.io.vn", null],
  ];
  it.each(rows)("%s", (host, expected) => {
    expect(parseWorkspaceHost(host, D)).toEqual(expected);
  });
});

describe("isValidWorkspaceSlug", () => {
  const rows: [string, boolean][] = [
    ["alice", true],
    ["abc", true],
    ["a1b2c3", true],
    ["a".repeat(20), true],
    ["a".repeat(21), false],
    ["ab", false],
    ["1abc", false],
    ["ab-c", false],
    ["Alice", false],
    ["admin", false],
    ["registry", false],
    ["kcode", false],
    ["", false],
  ];
  it.each(rows)("%s -> %s", (s, ok) => expect(isValidWorkspaceSlug(s)).toBe(ok));
  it("rejects every reserved label", () => {
    for (const l of RESERVED_LABELS) expect(isValidWorkspaceSlug(l)).toBe(false);
  });
});

describe("workspaceUrl / SERVICES", () => {
  it("builds URLs", () => {
    expect(workspaceUrl("alice", "t3", D)).toBe("https://alice-kcode.agentbox.io.vn/");
    expect(workspaceUrl("alice", "code", D)).toBe("https://alice-code.agentbox.io.vn/");
  });
  it("registry ports", () => {
    expect(SERVICES.t3.port).toBe(3773);
    expect(SERVICES.code.port).toBe(8080);
  });
});
