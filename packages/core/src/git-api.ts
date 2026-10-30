import { GIT_OAUTH, type GitMethod, type GitOAuthProviderId, type GitProviderId } from "./git.ts";

/**
 * Calls to git hosts' own APIs: OAuth code exchange / refresh, profile lookup, SSH key upload and
 * delete. Used by the web app (connect, disconnect) and the worker (key upload, token refresh).
 * Every call has a timeout and never follows redirects (hosts are user-entered).
 */

const TIMEOUT_MS = 10_000;

export class GitApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GitApiError";
  }
}

export interface GitAuth {
  provider: GitProviderId;
  host: string;
  method: GitMethod;
  token: string;
}

export interface GitProfile {
  /** Provider-side stable id (GitHub/GitLab/Gitea numeric id, Bitbucket account uuid). */
  providerUserId: string;
  login: string;
  /** Commit email AgentBox may use as git identity; null when none is known (Bitbucket). */
  email: string | null;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until the access token expires; null when it does not. */
  expiresIn: number | null;
  scope: string;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
    });
  } catch (e) {
    throw new GitApiError(e instanceof Error ? e.message : "request failed");
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new GitApiError(`${what} failed (${res.status})`, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new GitApiError(`${what}: unexpected response`, res.status);
  }
}

/** API root and request headers for a connection's token. */
function api(a: GitAuth): { base: string; headers: Record<string, string> } {
  const common = { Accept: "application/json", "User-Agent": "agentbox" };
  switch (a.provider) {
    case "github":
      return {
        base: GIT_OAUTH.github.apiBase,
        headers: {
          ...common,
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${a.token}`,
        },
      };
    case "gitlab":
    case "gitlab-self":
      return {
        base: a.provider === "gitlab" ? GIT_OAUTH.gitlab.apiBase : `https://${a.host}/api/v4`,
        headers: { ...common, Authorization: `Bearer ${a.token}` },
      };
    case "bitbucket":
      return {
        base: GIT_OAUTH.bitbucket.apiBase,
        headers: { ...common, Authorization: `Bearer ${a.token}` },
      };
    case "gitea":
      return {
        base: `https://${a.host}/api/v1`,
        headers: { ...common, Authorization: `token ${a.token}` },
      };
    case "generic":
      throw new GitApiError("This host has no API");
  }
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function basic(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function parseTokens(
  body: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
    scopes?: string;
    error?: string;
    error_description?: string;
  },
  ok: boolean,
  status: number,
): OAuthTokens {
  if (!ok || !body.access_token) {
    throw new GitApiError(
      body.error_description ?? body.error ?? `token request failed (${status})`,
      status,
    );
  }
  const expires = body.expires_in === undefined ? null : Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresIn: expires !== null && Number.isFinite(expires) && expires > 0 ? expires : null,
    scope: body.scope ?? body.scopes ?? "",
  };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Exchange an authorization code for tokens. */
export async function exchangeOAuthCode(
  provider: GitOAuthProviderId,
  client: OAuthClient,
  code: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const spec = GIT_OAUTH[provider];
  let res: Response;
  if (provider === "github") {
    res = await call(spec.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } else if (provider === "gitlab") {
    res = await call(spec.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } else {
    res = await call(spec.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(client.clientId, client.clientSecret),
      },
      body: formBody({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
  }
  const body = (await res.json().catch(() => ({}))) as Parameters<typeof parseTokens>[0];
  return parseTokens(body, res.ok, res.status);
}

/** Refresh an expiring access token (GitLab, Bitbucket). */
export async function refreshOAuthToken(
  provider: GitOAuthProviderId,
  client: OAuthClient,
  refreshToken: string,
): Promise<OAuthTokens> {
  const spec = GIT_OAUTH[provider];
  if (!spec.refreshable) throw new GitApiError(`${provider} tokens do not refresh`);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (provider === "bitbucket") headers.Authorization = basic(client.clientId, client.clientSecret);
  else {
    fields.client_id = client.clientId;
    fields.client_secret = client.clientSecret;
  }
  const res = await call(spec.tokenUrl, { method: "POST", headers, body: formBody(fields) });
  const body = (await res.json().catch(() => ({}))) as Parameters<typeof parseTokens>[0];
  return parseTokens(body, res.ok, res.status);
}

/** Best-effort OAuth grant revocation (GitLab only; GitHub is handled by the web app). */
export async function revokeGitlabToken(client: OAuthClient, token: string): Promise<void> {
  await call("https://gitlab.com/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, token }),
  });
}

/** The account a token belongs to; also the "is this token valid" check for self-hosted hosts. */
export async function fetchGitProfile(a: GitAuth): Promise<GitProfile> {
  const { base, headers } = api(a);
  switch (a.provider) {
    case "github": {
      const body = await json<{ id?: number; login?: string }>(
        await call(`${base}/user`, { headers }),
        "GET /user",
      );
      if (typeof body.id !== "number" || !body.login)
        throw new GitApiError("unexpected GET /user response");
      return {
        providerUserId: String(body.id),
        login: body.login,
        email: `${body.id}+${body.login}@users.noreply.github.com`,
      };
    }
    case "gitlab":
    case "gitlab-self": {
      const body = await json<{
        id?: number;
        username?: string;
        public_email?: string | null;
        commit_email?: string | null;
      }>(await call(`${base}/user`, { headers }), "GET /user");
      if (typeof body.id !== "number" || !body.username)
        throw new GitApiError("unexpected GET /user response");
      const email =
        body.commit_email ||
        body.public_email ||
        `${body.id}-${body.username}@users.noreply.${a.host}`;
      return { providerUserId: String(body.id), login: body.username, email };
    }
    case "gitea": {
      const body = await json<{ id?: number; login?: string; email?: string }>(
        await call(`${base}/user`, { headers }),
        "GET /user",
      );
      if (typeof body.id !== "number" || !body.login)
        throw new GitApiError("unexpected GET /user response");
      return { providerUserId: String(body.id), login: body.login, email: body.email || null };
    }
    case "bitbucket": {
      const body = await json<{
        uuid?: string;
        nickname?: string;
        username?: string;
        display_name?: string;
      }>(await call(`${base}/user`, { headers }), "GET /user");
      const login = body.nickname || body.username || body.display_name;
      if (!body.uuid || !login) throw new GitApiError("unexpected GET /user response");
      return { providerUserId: body.uuid, login, email: null };
    }
    case "generic":
      throw new GitApiError("This host has no API");
  }
}

/** `<type> <base64>` without the trailing comment, for comparing keys across providers. */
export function sshKeyMaterial(line: string): string {
  const [type, blob] = line.trim().split(/\s+/);
  return `${type ?? ""} ${blob ?? ""}`;
}

interface KeyRow {
  id: string;
  key: string;
}

function keysUrl(a: GitAuth, providerUserId: string | null): string {
  const { base } = api(a);
  if (a.provider === "bitbucket") {
    if (!providerUserId) throw new GitApiError("Bitbucket account id missing");
    return `${base}/users/${encodeURIComponent(providerUserId)}/ssh-keys`;
  }
  return `${base}/user/keys`;
}

async function listKeys(a: GitAuth, providerUserId: string | null): Promise<KeyRow[]> {
  const { headers } = api(a);
  let url: string | null =
    keysUrl(a, providerUserId) + (a.provider === "bitbucket" ? "?pagelen=100" : "?per_page=100");
  const rows: KeyRow[] = [];
  for (let page = 0; url && page < 10; page++) {
    const res = await call(url, { headers });
    if (a.provider === "bitbucket") {
      const body = await json<{ values?: { uuid: string; key: string }[]; next?: string }>(
        res,
        "list ssh keys",
      );
      for (const k of body.values ?? []) rows.push({ id: k.uuid, key: k.key });
      url = body.next && body.next.startsWith("https://api.bitbucket.org/") ? body.next : null;
    } else {
      const body = await json<{ id: number | string; key: string }[]>(res, "list ssh keys");
      for (const k of body) rows.push({ id: String(k.id), key: k.key });
      url = null;
    }
  }
  return rows;
}

/**
 * Add `publicKey` to the user's account, idempotently: a key already there (same key material) is
 * reused. Returns the provider's id for the key.
 */
export async function uploadSshKey(
  a: GitAuth,
  providerUserId: string | null,
  publicKey: string,
  title: string,
): Promise<string> {
  const want = sshKeyMaterial(publicKey);
  const existing = (await listKeys(a, providerUserId)).find((k) => sshKeyMaterial(k.key) === want);
  if (existing) return existing.id;
  const { headers } = api(a);
  const payload =
    a.provider === "bitbucket"
      ? { key: publicKey.trim(), label: title }
      : a.provider === "gitea"
        ? { key: publicKey.trim(), title, read_only: false }
        : { key: publicKey.trim(), title };
  const res = await call(keysUrl(a, providerUserId), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await json<{ id?: number | string; uuid?: string }>(res, "add ssh key");
  const id = body.uuid ?? (body.id === undefined ? null : String(body.id));
  if (!id) throw new GitApiError("add ssh key: unexpected response");
  return id;
}

/** Remove an uploaded key. A key that is already gone counts as removed. */
export async function deleteSshKey(
  a: GitAuth,
  providerUserId: string | null,
  keyId: string,
): Promise<void> {
  const { headers } = api(a);
  const res = await call(`${keysUrl(a, providerUserId)}/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 404)
    throw new GitApiError(`delete ssh key failed (${res.status})`, res.status);
}
