/** Runtime configuration, read lazily so `next build` never needs production env. */

export function baseDomain(): string {
  return (process.env.AGENTBOX_BASE_DOMAIN?.trim() || "agentbox.io.vn").toLowerCase();
}

export function appHost(): string {
  return `app.${baseDomain()}`;
}

export function appOrigin(): string {
  return `https://${appHost()}`;
}

export function encryptionKey(): string {
  const key = process.env.AGENTBOX_ENCRYPTION_KEY;
  if (!key) throw new Error("AGENTBOX_ENCRYPTION_KEY is not set");
  return key;
}

export function bootstrapAdminEmails(): string[] {
  return (process.env.AGENTBOX_BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export type LoginProvider = "google" | "github";

export function configuredProviders(): LoginProvider[] {
  const out: LoginProvider[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) out.push("github");
  return out;
}

export function githubConnectConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CONNECT_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CONNECT_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
