import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { gitCredentialUsername, githubCanUploadKeys, sshUploadSupported } from "@agentbox/core/git";
import type { PutGitRequest } from "@agentbox/core/agent-api";
import {
  GitApiError,
  deleteSshKey,
  refreshOAuthToken,
  uploadSshKey,
  type GitAuth,
} from "@agentbox/core/git-api";
import { decrypt, encrypt } from "@agentbox/core/tokens";
import { gitConnections, workspaces } from "@agentbox/db/schema";
import { AgentError } from "./agent-client.ts";
import { reconcileCopilot } from "./accounts.ts";
import { errMessage } from "./log.ts";
import { enqueueJob } from "./queue.ts";
import type { Ctx } from "./types.ts";

type WorkspaceRow = typeof workspaces.$inferSelect;
type ConnectionRow = typeof gitConnections.$inferSelect;

export const GIT_REFRESH_INTERVAL_MS = 15 * 60_000;
export const GIT_REFRESH_FIRST_RUN_MS = 30_000;
/** Connections whose access token expires within this window are refreshed. */
export const GIT_REFRESH_WINDOW_MS = 30 * 60_000;

const keyTitle = (ws: WorkspaceRow) => `AgentBox ${ws.slug}`;

function authOf(c: ConnectionRow, token: string): GitAuth {
  return { provider: c.provider, host: c.host, method: c.method, token };
}

/** git user.name/email come from the first connected account: GitHub if linked, else the oldest. */
function identityFrom(conns: ConnectionRow[]): PutGitRequest["identity"] {
  const primary = conns.find((c) => c.provider === "github") ?? conns[0];
  return primary?.email ? { name: primary.login, email: primary.email } : undefined;
}

/** 4xx from a provider is final for this sync (bad scope, key in use); anything else is worth a retry. */
function isFinalRejection(e: unknown): boolean {
  return (
    e instanceof GitApiError &&
    e.status !== null &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 429
  );
}

/**
 * Upload the workspace public key to every connection that can take it and has not got it yet.
 * Idempotent (the key is listed first and reused). Returns the connections whose upload failed
 * for a reason that may pass (network, 5xx).
 */
async function uploadKeys(
  ctx: Ctx,
  ws: WorkspaceRow,
  conns: ConnectionRow[],
  publicKey: string,
): Promise<string[]> {
  const keyChanged = ws.sshPublicKey !== publicKey;
  const transient: string[] = [];
  for (const conn of conns) {
    if (conn.status !== "active") continue;
    if (!sshUploadSupported(conn.provider, conn.method)) continue;
    if (conn.provider === "github" && !githubCanUploadKeys(conn.scopes)) continue;
    if (conn.sshKeyId && !keyChanged) continue;
    try {
      const auth = authOf(conn, decrypt(conn.tokenEnc, ctx.config.encryptionKey));
      if (conn.sshKeyId && ws.sshPublicKey) {
        // The workspace has a new key (recreated without its data): drop the stale one first.
        await deleteSshKey(auth, conn.providerUserId, conn.sshKeyId).catch((e) =>
          ctx.log.warn("stale ssh key delete failed", { host: conn.host, error: errMessage(e) }),
        );
      }
      const keyId = await uploadSshKey(auth, conn.providerUserId, publicKey, keyTitle(ws));
      await ctx.db
        .update(gitConnections)
        .set({ sshKeyId: keyId, lastError: null, updatedAt: ctx.now() })
        .where(eq(gitConnections.id, conn.id));
    } catch (e) {
      ctx.log.warn("ssh key upload failed", { ws: ws.slug, host: conn.host, error: errMessage(e) });
      if (isFinalRejection(e)) {
        await ctx.db
          .update(gitConnections)
          .set({ lastError: `SSH key upload failed: ${errMessage(e)}`, updatedAt: ctx.now() })
          .where(eq(gitConnections.id, conn.id));
      } else {
        transient.push(conn.host);
      }
    }
  }
  return transient;
}

/**
 * Reconcile the workspace's git and Copilot accounts with the DB: push the full desired state of
 * `git_connections` to the agent, store the workspace SSH public key it returns, upload that key to
 * each provider that can take it, then reconcile Copilot.
 */
export async function reconcileGit(ctx: Ctx, ws: WorkspaceRow): Promise<void> {
  if (ws.status !== "running") {
    await ctx.db.update(workspaces).set({ gitSyncPending: true }).where(eq(workspaces.id, ws.id));
    return;
  }
  const conns = await ctx.db
    .select()
    .from(gitConnections)
    .where(eq(gitConnections.userId, ws.userId))
    .orderBy(asc(gitConnections.createdAt));
  const req: PutGitRequest = {
    connections: conns.map((c) => ({
      provider: c.provider,
      host: c.host,
      login: c.login,
      token: decrypt(c.tokenEnc, ctx.config.encryptionKey),
      username: gitCredentialUsername(c),
      ...(c.knownHosts ? { knownHosts: c.knownHosts } : {}),
    })),
    ...(identityFrom(conns) ? { identity: identityFrom(conns) } : {}),
  };
  let transient: string[];
  try {
    const { sshPublicKey } = await ctx.agent.putGit(ws.slug, req);
    transient = await uploadKeys(ctx, ws, conns, sshPublicKey);
    if (ws.sshPublicKey !== sshPublicKey) {
      await ctx.db.update(workspaces).set({ sshPublicKey }).where(eq(workspaces.id, ws.id));
    }
    await reconcileCopilot(ctx, ws);
  } catch (e) {
    // 409: the container is not running (anymore); the next start reconciles.
    if (e instanceof AgentError && e.status === 409) {
      await ctx.db.update(workspaces).set({ gitSyncPending: true }).where(eq(workspaces.id, ws.id));
      return;
    }
    throw e;
  }
  await ctx.db.update(workspaces).set({ gitSyncPending: false }).where(eq(workspaces.id, ws.id));
  // Everything else is applied; let the job retry just for uploads that failed for transient reasons.
  if (transient.length > 0) {
    throw new Error(`ssh key upload to ${transient.join(", ")} failed; will retry`);
  }
}

/**
 * Refresh OAuth connections whose access token expires soon. A rejected refresh (revoked grant)
 * marks the connection `error` so the UI asks the user to reconnect; a transient failure is retried
 * next cycle. A refreshed connection of a running workspace re-syncs so the credential store gets
 * the new token. Returns the number refreshed.
 */
export async function refreshGitTokens(ctx: Ctx): Promise<number> {
  const horizon = new Date(ctx.now().getTime() + GIT_REFRESH_WINDOW_MS);
  const due = await ctx.db
    .select()
    .from(gitConnections)
    .where(
      and(
        eq(gitConnections.method, "oauth"),
        eq(gitConnections.status, "active"),
        isNotNull(gitConnections.refreshTokenEnc),
        isNotNull(gitConnections.expiresAt),
        lt(gitConnections.expiresAt, horizon),
      ),
    );
  let refreshed = 0;
  for (const conn of due) {
    try {
      if (await refreshOne(ctx, conn)) refreshed++;
    } catch (e) {
      ctx.log.error("git token refresh failed", { host: conn.host, error: errMessage(e) });
    }
  }
  return refreshed;
}

async function refreshOne(ctx: Ctx, conn: ConnectionRow): Promise<boolean> {
  const provider = conn.provider;
  const client =
    provider === "gitlab" || provider === "bitbucket" ? ctx.config.gitOAuth[provider] : undefined;
  if (!client || (provider !== "gitlab" && provider !== "bitbucket")) {
    ctx.log.warn("git token refresh skipped: oauth client not configured", { host: conn.host });
    return false;
  }
  try {
    const tokens = await refreshOAuthToken(
      provider,
      client,
      decrypt(conn.refreshTokenEnc!, ctx.config.encryptionKey),
    );
    const key = ctx.config.encryptionKey;
    await ctx.db
      .update(gitConnections)
      .set({
        tokenEnc: encrypt(tokens.accessToken, key),
        // Providers rotate refresh tokens; keep the old one when none is returned.
        ...(tokens.refreshToken ? { refreshTokenEnc: encrypt(tokens.refreshToken, key) } : {}),
        expiresAt: tokens.expiresIn
          ? new Date(ctx.now().getTime() + tokens.expiresIn * 1000)
          : null,
        lastError: null,
        updatedAt: ctx.now(),
      })
      .where(eq(gitConnections.id, conn.id));
  } catch (e) {
    if (!isFinalRejection(e)) throw e;
    await ctx.db
      .update(gitConnections)
      .set({
        status: "error",
        lastError: `Token refresh rejected: ${errMessage(e)}`,
        updatedAt: ctx.now(),
      })
      .where(eq(gitConnections.id, conn.id));
    return false;
  }
  const [ws] = await ctx.db
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, conn.userId));
  if (ws?.status === "running") {
    await enqueueJob(ctx.db, { type: "sync_git", workspaceId: ws.id });
  } else if (ws && ws.status !== "deleted" && ws.status !== "deleting") {
    // Applied on the workspace's next start.
    await ctx.db.update(workspaces).set({ gitSyncPending: true }).where(eq(workspaces.id, ws.id));
  }
  return true;
}

/** Periodic token refresh (same self-rescheduling loop shape as the other worker loops). */
export function startGitRefreshLoop(
  ctx: Ctx,
  opts: { firstRunMs?: number; intervalMs?: number } = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    refreshGitTokens(ctx)
      .catch((e) => ctx.log.error("git refresh loop failed", { error: errMessage(e) }))
      .then(() => {
        if (!stopped) timer = setTimeout(run, opts.intervalMs ?? GIT_REFRESH_INTERVAL_MS);
      });
  };
  timer = setTimeout(run, opts.firstRunMs ?? GIT_REFRESH_FIRST_RUN_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
