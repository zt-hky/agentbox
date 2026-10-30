import { and, asc, eq, sql } from "drizzle-orm";
import { decrypt, encrypt } from "@agentbox/core/tokens";
import {
  GIT_OAUTH_PROVIDER_IDS,
  GIT_OAUTH,
  GIT_PROVIDERS,
  GIT_TOKEN_PROVIDER_IDS,
  isGitOAuthProvider,
  githubCanUploadKeys,
  gitTokenPageUrl,
  gitTokenScopesHint,
  normalizeGitHost,
  pinnedKnownHosts,
  sshUploadSupported,
  type GitMethod,
  type GitOAuthProviderId,
  type GitProviderId,
  type GitTokenProviderId,
} from "@agentbox/core/git";
import {
  deleteSshKey,
  fetchGitProfile,
  GitApiError,
  revokeGitlabToken,
} from "@agentbox/core/git-api";
import { hasGithubScope, GITHUB_WORKFLOW_SCOPE } from "@agentbox/core/accounts";
import { gitConnections, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db, DbLike } from "./db-types";
import { encryptionKey, gitOAuthConfig } from "./env";
import { UserError } from "./errors";
import { revokeConnection } from "./git-oauth";
import { isPublicHost, scanSshHostKeys, type HostResolver } from "./git-host";
import { enqueueWorkspaceJob } from "./jobs";

/** The user's linked git hosts: what the Accounts page and the onboarding step render. */

export interface GitProviderCard {
  id: GitOAuthProviderId;
  label: string;
  host: string;
  oauthConfigured: boolean;
  /** Start of the Connect round trip; append `?next=/onboarding` there (GitHub also `workflow=1`). */
  connectUrl: string;
  tokenUrl: string;
  tokenScopes: string;
}

export type GitSshState = "uploaded" | "pending" | "manual" | "reconnect";

export interface GitConnectionView {
  id: string;
  provider: GitProviderId;
  host: string;
  method: GitMethod;
  login: string;
  status: "active" | "error";
  lastError: string | null;
  https: boolean;
  /**
   * uploaded = the workspace key is at the provider; pending = upload supported, not done yet;
   * manual = the provider cannot take the key through an API (add it by hand);
   * reconnect = a GitHub token without `write:public_key`.
   */
  ssh: GitSshState;
  scopes: string | null;
  workflowScope: boolean;
  createdAt: Date;
}

export interface GitAccountsView {
  providers: GitProviderCard[];
  connections: GitConnectionView[];
  workspaceSshPublicKey: string | null;
  hasWorkspace: boolean;
}

type ConnectionRow = typeof gitConnections.$inferSelect;

function sshState(c: ConnectionRow): GitSshState {
  if (c.sshKeyId) return "uploaded";
  if (c.provider === "github" && !githubCanUploadKeys(c.scopes)) return "reconnect";
  return sshUploadSupported(c.provider, c.method) ? "pending" : "manual";
}

export async function loadGitAccountsView(
  database: DbLike,
  userId: string,
): Promise<GitAccountsView> {
  const rows = await database
    .select()
    .from(gitConnections)
    .where(eq(gitConnections.userId, userId))
    .orderBy(asc(gitConnections.createdAt));
  const [ws] = await database
    .select({ status: workspaces.status, sshPublicKey: workspaces.sshPublicKey })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  const live = ws && ws.status !== "deleted" && ws.status !== "deleting" ? ws : null;
  return {
    providers: GIT_OAUTH_PROVIDER_IDS.map((id) => ({
      id,
      label: GIT_PROVIDERS[id].label,
      host: GIT_OAUTH[id].host,
      oauthConfigured: gitOAuthConfig(id) !== null,
      connectUrl: `/api/git/${id}/connect`,
      tokenUrl: gitTokenPageUrl(id, GIT_OAUTH[id].host),
      tokenScopes: gitTokenScopesHint(id),
    })),
    connections: rows.map((c) => ({
      id: c.id,
      provider: c.provider,
      host: c.host,
      method: c.method,
      login: c.login,
      status: c.status,
      lastError: c.lastError,
      https: true,
      ssh: sshState(c),
      scopes: c.scopes,
      workflowScope: c.provider === "github" && hasGithubScope(c.scopes, GITHUB_WORKFLOW_SCOPE),
      createdAt: c.createdAt,
    })),
    workspaceSshPublicKey: live?.sshPublicKey ?? null,
    hasWorkspace: live !== null,
  };
}

export interface UpsertGitConnection {
  userId: string;
  provider: GitProviderId;
  host: string;
  method: GitMethod;
  login: string;
  email: string | null;
  providerUserId: string | null;
  token: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  /** Self-hosted hosts only: ssh-keyscan result; absent keeps what is stored. */
  knownHosts?: string | null;
  ip: string | null;
}

/**
 * Create or replace the user's connection to `host` and queue a workspace sync, atomically. The
 * uploaded SSH key id survives re-auth of the same provider account and is dropped for another one.
 */
export async function upsertGitConnection(
  database: Db,
  input: UpsertGitConnection,
): Promise<string> {
  const key = encryptionKey();
  const values = {
    userId: input.userId,
    provider: input.provider,
    host: input.host,
    method: input.method,
    login: input.login,
    email: input.email,
    providerUserId: input.providerUserId,
    tokenEnc: encrypt(input.token, key),
    refreshTokenEnc: input.refreshToken ? encrypt(input.refreshToken, key) : null,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
    status: "active" as const,
    lastError: null,
    updatedAt: new Date(),
  };
  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(gitConnections)
      .values({ ...values, knownHosts: input.knownHosts ?? null })
      .onConflictDoUpdate({
        target: [gitConnections.userId, gitConnections.host],
        set: {
          ...values,
          ...(input.knownHosts !== undefined ? { knownHosts: input.knownHosts } : {}),
          sshKeyId: sql`case when ${gitConnections.providerUserId} is not distinct from ${input.providerUserId} and ${gitConnections.provider} = ${input.provider} then ${gitConnections.sshKeyId} else null end`,
        },
      })
      .returning({ id: gitConnections.id });
    const [ws] = await tx
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.userId, input.userId))
      .limit(1);
    if (ws && ws.status !== "deleted" && ws.status !== "deleting") {
      await enqueueWorkspaceJob(tx, ws.id, { type: "sync_git" });
    }
    await writeAudit(tx, {
      actorId: input.userId,
      action: "git.connected",
      targetType: "user",
      targetId: input.userId,
      metadata: {
        provider: input.provider,
        host: input.host,
        method: input.method,
        login: input.login,
      },
      ip: input.ip,
    });
    return row!.id;
  });
}

export interface AddTokenInput {
  userId: string;
  provider: string;
  host: string;
  username: string;
  token: string;
  ip: string | null;
}

export interface AddTokenDeps {
  resolve?: HostResolver;
  scan?: (host: string) => Promise<string | null>;
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;

function isTokenProvider(p: string): p is GitTokenProviderId {
  return (GIT_TOKEN_PROVIDER_IDS as readonly string[]).includes(p);
}

/**
 * Add or replace a personal-access-token connection. The host must be a public https hostname; the
 * token is verified against the host's API (GitLab, Gitea) or by format only (generic).
 */
export async function addGitTokenConnection(
  database: Db,
  input: AddTokenInput,
  deps: AddTokenDeps = {},
): Promise<{ id: string }> {
  if (!isTokenProvider(input.provider)) throw new UserError("Unsupported git provider");
  const provider = input.provider;
  const host = provider === "gitlab" ? GIT_OAUTH.gitlab.host : normalizeGitHost(input.host);
  if (!host) {
    throw new UserError(
      "Enter a valid hostname such as git.example.com (https only; no IP addresses, ports or localhost).",
    );
  }
  const token = input.token.trim();
  const username = input.username.trim();
  if (!token || token.length > 2048 || CONTROL_OR_SPACE.test(token)) {
    throw new UserError("Enter the access token without spaces or line breaks.");
  }
  if (
    !username ||
    username.length > 100 ||
    CONTROL_OR_SPACE.test(username) ||
    username.startsWith("-")
  ) {
    throw new UserError("Enter your username on that host.");
  }
  if (!(await isPublicHost(host, deps.resolve))) {
    throw new UserError("That host could not be reached or is not a public address.");
  }

  let login = username;
  let email: string | null = null;
  let providerUserId: string | null = null;
  if (provider !== "generic") {
    try {
      const profile = await fetchGitProfile({ provider, host, method: "token", token });
      login = profile.login;
      email = profile.email;
      providerUserId = profile.providerUserId;
    } catch (e) {
      if (e instanceof GitApiError) throw new UserError("The host rejected this token.");
      throw e;
    }
  }
  const knownHosts = pinnedKnownHosts(host) ? null : await (deps.scan ?? scanSshHostKeys)(host);
  const id = await upsertGitConnection(database, {
    userId: input.userId,
    provider,
    host,
    method: "token",
    login,
    email,
    providerUserId,
    token,
    refreshToken: null,
    expiresAt: null,
    scopes: null,
    knownHosts,
    ip: input.ip,
  });
  return { id };
}

export async function loadConnection(
  database: DbLike,
  userId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const [row] = await database
    .select()
    .from(gitConnections)
    .where(and(eq(gitConnections.userId, userId), eq(gitConnections.id, connectionId)))
    .limit(1);
  return row ?? null;
}

/**
 * After a disconnect: delete the uploaded SSH key at the provider and revoke the OAuth grant.
 * Best effort by design: the row is already gone, and a dead token must not block the user.
 */
export async function releaseDisconnectedConnection(conn: ConnectionRow): Promise<void> {
  let token: string;
  try {
    token = decrypt(conn.tokenEnc, encryptionKey());
  } catch (e) {
    console.error("git disconnect: token unreadable", e);
    return;
  }
  const auth = { provider: conn.provider, host: conn.host, method: conn.method, token };
  if (conn.sshKeyId) {
    try {
      await deleteSshKey(auth, conn.providerUserId, conn.sshKeyId);
    } catch (e) {
      console.error(`git disconnect: ssh key delete failed (${conn.host})`, e);
    }
  }
  if (conn.method !== "oauth") return;
  try {
    const cfg = isGitOAuthProvider(conn.provider) ? gitOAuthConfig(conn.provider) : null;
    if (!cfg) return;
    if (conn.provider === "github") await revokeConnection(cfg, token);
    else if (conn.provider === "gitlab") await revokeGitlabToken(cfg, token);
  } catch (e) {
    console.error(`git disconnect: revoke failed (${conn.host})`, e);
  }
}
