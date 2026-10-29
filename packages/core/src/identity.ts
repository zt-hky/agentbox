import { createHmac } from "node:crypto";

export interface GatewayIdentityInput {
  secret: string; // base64url
  audience: string;
  sub: string;
  email: string;
  nowSeconds: number;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

export function signGatewayIdentity(i: GatewayIdentityInput): string {
  const header = b64url('{"alg":"HS256","typ":"JWT"}');
  const payload = b64url(
    JSON.stringify({
      iss: "agentbox",
      aud: i.audience,
      sub: i.sub,
      email: i.email,
      iat: i.nowSeconds,
      exp: i.nowSeconds + 120,
    }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", Buffer.from(i.secret, "base64url")).update(data).digest();
  return `${data}.${b64url(sig)}`;
}
