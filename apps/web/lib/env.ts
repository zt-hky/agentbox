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

export type GithubConnectConfig = {
  clientId: string;
  clientSecret: string;
  /** Path (under the app origin) registered/accepted as the OAuth redirect URI. */
  callbackPath: string;
  /** True when the sign-in OAuth App is reused; its grant also carries the user's sign-in. */
  shared: boolean;
};

export const GITHUB_CONNECT_CALLBACK_PATH = "/api/github/callback";
/** A subdirectory of the sign-in app's registered callback (`/api/auth/callback/github`). */
export const GITHUB_SHARED_CALLBACK_PATH = "/api/auth/callback/github/connect";

/** Dedicated `GITHUB_CONNECT_*` app wins; else reuse the sign-in `GITHUB_CLIENT_*` app. */
export function githubConnectConfig(): GithubConnectConfig | null {
  const id = process.env.GITHUB_CONNECT_CLIENT_ID;
  const secret = process.env.GITHUB_CONNECT_CLIENT_SECRET;
  if (id && secret) {
    return {
      clientId: id,
      clientSecret: secret,
      callbackPath: GITHUB_CONNECT_CALLBACK_PATH,
      shared: false,
    };
  }
  const sharedId = process.env.GITHUB_CLIENT_ID;
  const sharedSecret = process.env.GITHUB_CLIENT_SECRET;
  if (sharedId && sharedSecret) {
    return {
      clientId: sharedId,
      clientSecret: sharedSecret,
      callbackPath: GITHUB_SHARED_CALLBACK_PATH,
      shared: true,
    };
  }
  return null;
}
