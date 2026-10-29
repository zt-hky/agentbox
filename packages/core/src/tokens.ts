import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

function keyBytes(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("encryption key must decode to 32 bytes");
  return key;
}

export function encrypt(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${Buffer.concat([ct, tag]).toString("base64url")}`;
}

export function decrypt(payload: string, keyB64: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("invalid ciphertext format");
  const iv = Buffer.from(parts[1]!, "base64url");
  const blob = Buffer.from(parts[2]!, "base64url");
  if (iv.length !== 12 || blob.length < 16) throw new Error("invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(keyB64), iv);
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([
    decipher.update(blob.subarray(0, blob.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}
