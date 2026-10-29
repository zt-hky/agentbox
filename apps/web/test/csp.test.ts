import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce, securityHeaders } from "../lib/csp";

describe("csp", () => {
  it("builds the plan's policy with the nonce", () => {
    expect(buildCsp("abc")).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-abc' 'strict-dynamic'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self' https://accounts.google.com https://github.com",
      ].join("; "),
    );
  });

  it("allows eval only in dev", () => {
    expect(buildCsp("n")).not.toContain("unsafe-eval");
    expect(buildCsp("n", { dev: true })).toContain("'unsafe-eval'");
  });

  it("generates distinct base64 nonces", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("sets the extra security headers", () => {
    const h = securityHeaders("n");
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("'nonce-n'");
  });
});
