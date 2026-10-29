import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** `Authorization: Bearer <token>` check. Digests are compared so length never short-circuits. */
export function checkBearer(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string" || token.length === 0) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  return timingSafeEqual(sha256(m[1] as string), sha256(token));
}
