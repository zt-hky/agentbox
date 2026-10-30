import { and, eq } from "drizzle-orm";
import {
  copilotDetailSchema,
  type CopilotDetail,
  type CopilotIntegrationStatus,
} from "@agentbox/core/accounts";
import { gitConnections, workspaceIntegrations, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db, DbLike } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";

/** Account integrations the user controls from /settings/accounts (git hosts, Copilot). */

type IntegrationRow = typeof workspaceIntegrations.$inferSelect;

export interface CopilotView {
  status: CopilotIntegrationStatus;
  detail: CopilotDetail;
  observedAt: Date;
}

const LIVE: readonly CopilotIntegrationStatus[] = ["starting", "code", "cancelling"];

async function liveWorkspace(database: DbLike, userId: string) {
  const [ws] = await database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (!ws || ws.status === "deleted" || ws.status === "deleting")
    throw new UserError("You have no workspace");
  return ws;
}

const copilotRow = (workspaceId: string) =>
  and(
    eq(workspaceIntegrations.workspaceId, workspaceId),
    eq(workspaceIntegrations.kind, "copilot"),
  );

async function loadCopilot(database: DbLike, workspaceId: string): Promise<IntegrationRow | null> {
  const [row] = await database
    .select()
    .from(workspaceIntegrations)
    .where(copilotRow(workspaceId))
    .limit(1);
  return row ?? null;
}

function toView(row: IntegrationRow | null): CopilotView | null {
  if (!row) return null;
  const parsed = copilotDetailSchema.safeParse(row.detail);
  return {
    status: row.status,
    detail: parsed.success ? parsed.data : {},
    observedAt: row.observedAt,
  };
}

export async function getCopilotView(
  database: DbLike,
  userId: string,
): Promise<{ workspaceStatus: string | null; copilot: CopilotView | null }> {
  const [ws] = await database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (!ws) return { workspaceStatus: null, copilot: null };
  return { workspaceStatus: ws.status, copilot: toView(await loadCopilot(database, ws.id)) };
}

/**
 * Begin `copilot login --device-code` in the workspace. The container must be awake: the code is
 * only valid for 15 minutes and the CLI runs inside the workspace. A live sign-in is reused.
 */
export function requestCopilotLogin(
  database: Db,
  input: { userId: string; ip: string | null },
): Promise<CopilotView> {
  return database.transaction((tx) => requestCopilotLoginTx(tx, input));
}

async function requestCopilotLoginTx(
  tx: DbLike,
  input: { userId: string; ip: string | null },
): Promise<CopilotView> {
  const ws = await liveWorkspace(tx, input.userId);
  if (ws.status !== "running")
    throw new UserError("Your workspace is asleep. Open it, then sign in to Copilot.");
  const cur = await loadCopilot(tx, ws.id);
  if (cur && (LIVE as readonly string[]).includes(cur.status) && cur.status !== "cancelling")
    return toView(cur)!;
  if (cur?.status === "signed_in") throw new UserError("Copilot is already signed in");
  if (cur?.status === "signing_out" || cur?.status === "cancelling")
    throw new UserError("Copilot is still finishing the previous request. Try again in a moment.");
  const now = new Date();
  await tx
    .insert(workspaceIntegrations)
    .values({
      workspaceId: ws.id,
      kind: "copilot",
      status: "starting",
      detail: {},
      observedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceIntegrations.workspaceId, workspaceIntegrations.kind],
      set: { status: "starting", detail: {}, observedAt: now },
    });
  await enqueueWorkspaceJob(tx, ws.id, { type: "copilot_login" });
  await writeAudit(tx, {
    actorId: input.userId,
    action: "copilot.login_requested",
    targetType: "workspace",
    targetId: ws.id,
    ip: input.ip,
  });
  return { status: "starting", detail: {}, observedAt: now };
}

/** Stop a live sign-in (the worker kills the CLI) or sign out a finished one. */
export async function cancelOrSignOutCopilot(
  database: DbLike,
  input: { userId: string; ip: string | null },
): Promise<void> {
  const ws = await liveWorkspace(database, input.userId);
  const cur = await loadCopilot(database, ws.id);
  if (!cur) return;
  const live = cur.status === "starting" || cur.status === "code";
  const next: CopilotIntegrationStatus = live ? "cancelling" : "signing_out";
  if (cur.status === "cancelling" || cur.status === "signing_out") return;
  await database
    .update(workspaceIntegrations)
    .set({ status: next, observedAt: new Date() })
    .where(copilotRow(ws.id));
  if (!live) {
    // sync_git reconciles Copilot too; a sleeping workspace applies it on next start.
    await enqueueWorkspaceJob(database, ws.id, { type: "sync_git" });
  }
  await writeAudit(database, {
    actorId: input.userId,
    action: live ? "copilot.login_cancelled" : "copilot.signed_out",
    targetType: "workspace",
    targetId: ws.id,
    ip: input.ip,
  });
}

/**
 * Remove one git connection and everything it put in the workspace (credentials, SSH config block;
 * for GitHub also gh login and the Copilot sign-in AgentBox did). The row delete and the reverse
 * state are queued in one transaction; the worker applies them now or on next start. Returns the
 * removed row so the caller can delete the uploaded key and revoke the grant at the provider.
 */
export async function disconnectGitConnection(
  database: Db,
  input: { userId: string; connectionId: string; ip: string | null },
): Promise<typeof gitConnections.$inferSelect | null> {
  return database.transaction(async (tx) => {
    const [conn] = await tx
      .delete(gitConnections)
      .where(
        and(eq(gitConnections.id, input.connectionId), eq(gitConnections.userId, input.userId)),
      )
      .returning();
    if (!conn) return null;
    const [ws] = await tx
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.userId, input.userId))
      .limit(1);
    if (ws && ws.status !== "deleted" && ws.status !== "deleting") {
      if (conn.provider === "github") {
        const cop = await loadCopilot(tx, ws.id);
        if (cop && cop.status !== "signing_out") {
          const live = cop.status === "starting" || cop.status === "code";
          // A live sign-in is cancelled by the worker loop, then signed out on the next sync.
          await tx
            .update(workspaceIntegrations)
            .set({ status: live ? "cancelling" : "signing_out", observedAt: new Date() })
            .where(copilotRow(ws.id));
        }
      }
      await enqueueWorkspaceJob(tx, ws.id, { type: "sync_git" });
    }
    await writeAudit(tx, {
      actorId: input.userId,
      action: "git.disconnected",
      targetType: "user",
      targetId: input.userId,
      metadata: { provider: conn.provider, host: conn.host, login: conn.login },
      ip: input.ip,
    });
    return conn;
  });
}
