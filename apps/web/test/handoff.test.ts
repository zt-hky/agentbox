import { describe, expect, it } from "vitest";
import { decideHandoff } from "../lib/handoff";
import { isBlockedAuthPath } from "../lib/auth-paths";
import { sanitizeNextPath, sanitizeReturnPath } from "../lib/paths";

describe("sanitizeReturnPath", () => {
  it.each([
    [null, "/"],
    [undefined, "/"],
    ["", "/"],
    ["/", "/"],
    ["/projects/x?y=1#z", "/projects/x?y=1#z"],
    ["//evil.com", "/evil.com"],
    ["///evil.com/a", "/evil.com/a"],
    ["/\\evil.com", "/evil.com"],
    ["\\\\evil.com", "/evil.com"],
    ["/a\\b", "/"],
    ["https://evil.com", "/"],
    ["relative", "/"],
    ["/a\nb", "/"],
    ["/a\u0000b", "/"],
    ["/" + "a".repeat(3000), "/"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });

  it("never yields a protocol-relative or non-slash-leading result", () => {
    for (const p of ["//", "/////x", "/\t/x", "/ /x", "//\\x"]) {
      const out = sanitizeReturnPath(p);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
    }
  });
});

describe("sanitizeNextPath", () => {
  it.each([
    ["/admin?x=1", "/admin?x=1"],
    ["//evil.com", "/"],
    ["https://evil.com", "/"],
    ["/\\evil.com", "/"],
    [null, "/"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeNextPath(input)).toBe(expected);
  });
});

describe("decideHandoff", () => {
  const baseDomain = "agentbox.io.vn";
  const alice = { id: "u1", role: "user", accessStatus: "active" };
  const admin = { id: "u9", role: "admin", accessStatus: "active" };
  const ws = { id: "w1", userId: "u1", slug: "alice", status: "running" };
  const host = "alice-t3.agentbox.io.vn";

  it("issues for the owner, both services", () => {
    expect(decideHandoff({ baseDomain, host, user: alice, workspace: ws })).toEqual({
      action: "issue",
      host,
      ws: "alice",
    });
    expect(
      decideHandoff({ baseDomain, host: "alice-code.agentbox.io.vn", user: alice, workspace: ws }),
    ).toMatchObject({ action: "issue" });
  });

  it("requires confirmation for an admin opening someone else's workspace", () => {
    expect(decideHandoff({ baseDomain, host, user: admin, workspace: ws })).toEqual({
      action: "confirm",
      host,
      ws: "alice",
    });
  });

  it("an admin opening their own workspace is a plain issue", () => {
    const own = { ...ws, userId: "u9" };
    expect(decideHandoff({ baseDomain, host, user: admin, workspace: own })).toMatchObject({
      action: "issue",
    });
  });

  it("denies other users", () => {
    const bob = { id: "u2", role: "user", accessStatus: "active" };
    expect(decideHandoff({ baseDomain, host, user: bob, workspace: ws })).toMatchObject({
      action: "deny",
      status: 403,
    });
  });

  it("denies inactive accounts, even admins", () => {
    for (const u of [
      { ...alice, accessStatus: "suspended" },
      { ...admin, accessStatus: "pending" },
    ]) {
      expect(decideHandoff({ baseDomain, host, user: u, workspace: ws })).toMatchObject({
        action: "deny",
        status: 403,
      });
    }
  });

  it.each([
    [null],
    [""],
    ["alice-t3.evil.com"],
    ["alice.agentbox.io.vn"],
    ["alice-t3.agentbox.io.vn:8443"],
    ["ALICE-T3.agentbox.io.vn"],
    ["alice-p5173.agentbox.io.vn"],
    ["app-t3.agentbox.io.vn"],
    ["a.alice-t3.agentbox.io.vn"],
  ])("denies malformed or unknown host %j", (h) => {
    expect(decideHandoff({ baseDomain, host: h, user: alice, workspace: ws })).toMatchObject({
      action: "deny",
    });
  });

  it("404s when the slug does not match or the workspace is deleted", () => {
    expect(
      decideHandoff({ baseDomain, host, user: alice, workspace: { ...ws, slug: "bob" } }),
    ).toMatchObject({ action: "deny", status: 404 });
    expect(
      decideHandoff({ baseDomain, host, user: alice, workspace: { ...ws, status: "deleted" } }),
    ).toMatchObject({ action: "deny", status: 404 });
    expect(decideHandoff({ baseDomain, host, user: alice, workspace: null })).toMatchObject({
      action: "deny",
      status: 404,
    });
  });
});

describe("isBlockedAuthPath", () => {
  it.each([
    ["/api/auth/admin/list-users", true],
    ["/api/auth/admin", true],
    ["/api/auth/ADMIN/set-role", true],
    ["/api/auth//admin/set-role", true],
    ["/api/auth/%61dmin/set-role", true],
    ["/api/auth/sign-in/social", false],
    ["/api/auth/get-session", false],
  ])("%s -> blocked=%s", (p, blocked) => {
    expect(isBlockedAuthPath(p)).toBe(blocked);
  });
});
