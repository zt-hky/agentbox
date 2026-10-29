import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signGatewayIdentity } from "../src/identity.ts";

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/gateway-identity.json", import.meta.url), "utf8"),
) as {
  secret: string;
  audience: string;
  sub: string;
  email: string;
  nowSeconds: number;
  token: string;
};

describe("signGatewayIdentity", () => {
  it("reproduces the shared fixture token exactly", () => {
    expect(
      signGatewayIdentity({
        secret: fx.secret,
        audience: fx.audience,
        sub: fx.sub,
        email: fx.email,
        nowSeconds: fx.nowSeconds,
      }),
    ).toBe(fx.token);
  });
  it("claims", () => {
    const [h, p] = fx.token.split(".");
    expect(Buffer.from(h!, "base64url").toString()).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iss: "agentbox",
      aud: "alice",
      sub: "user_123",
      email: "alice@example.com",
      iat: 1767225600,
      exp: 1767225720,
    });
  });
  it("different secret/audience changes the token", () => {
    const base = { secret: fx.secret, audience: "alice", sub: "u", email: "e@x.y", nowSeconds: 1 };
    const t = signGatewayIdentity(base);
    expect(signGatewayIdentity({ ...base, audience: "bob" })).not.toBe(t);
    expect(
      signGatewayIdentity({ ...base, secret: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA" }),
    ).not.toBe(t);
  });
});
