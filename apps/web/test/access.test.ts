import { describe, expect, it } from "vitest";
import { decideAccess } from "../lib/access";

const active = { role: "user", accessStatus: "active" };
const admin = { role: "admin", accessStatus: "active" };

describe("decideAccess", () => {
  it("sends anonymous users to /login with next", () => {
    expect(decideAccess({ pathname: "/", search: "", user: null })).toEqual({
      type: "redirect",
      to: "/login?next=%2F",
    });
    expect(decideAccess({ pathname: "/billing", search: "?a=1", user: null })).toEqual({
      type: "redirect",
      to: "/login?next=%2Fbilling%3Fa%3D1",
    });
  });
  it("lets anonymous users see /login and auth endpoints", () => {
    expect(decideAccess({ pathname: "/login", search: "", user: null }).type).toBe("next");
    expect(decideAccess({ pathname: "/api/auth/get-session", search: "", user: null }).type).toBe(
      "next",
    );
  });
  it("sends non-active users to /request-access", () => {
    for (const s of ["none", "pending", "rejected", "suspended"]) {
      const user = { role: "user", accessStatus: s };
      expect(decideAccess({ pathname: "/", search: "", user })).toEqual({
        type: "redirect",
        to: "/request-access",
      });
      expect(decideAccess({ pathname: "/request-access", search: "", user }).type).toBe("next");
    }
  });
  it("keeps active users out of /request-access and /login", () => {
    expect(decideAccess({ pathname: "/request-access", search: "", user: active })).toEqual({
      type: "redirect",
      to: "/",
    });
    expect(decideAccess({ pathname: "/login", search: "?next=/billing", user: active })).toEqual({
      type: "redirect",
      to: "/billing",
    });
  });
  it("gates /admin on role", () => {
    expect(decideAccess({ pathname: "/admin", search: "", user: active })).toEqual({
      type: "redirect",
      to: "/",
    });
    expect(decideAccess({ pathname: "/admin/users", search: "", user: active })).toEqual({
      type: "redirect",
      to: "/",
    });
    expect(decideAccess({ pathname: "/admin/users", search: "", user: admin }).type).toBe("next");
  });
});
