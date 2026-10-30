import { and, eq, inArray, ne } from "drizzle-orm";
import {
  COPILOT_TERMINAL_STATUSES,
  copilotDetailSchema,
  type CopilotDetail,
  type CopilotIntegrationStatus,
  type CopilotLoginState,
} from "@agentbox/core/accounts";
import { workspaceIntegrations, workspaces } from "@agentbox/db/schema";
import { AgentError } from "./agent-client.ts";
import { errMessage } from "./log.ts";
import type { Ctx } from "./types.ts";

type WorkspaceRow = typeof workspaces.$inferSelect;
type IntegrationRow = typeof workspaceIntegrations.$inferSelect;

export const COPILOT_POLL_INTERVAL_MS = 2000;
/** A requested sign-in whose session never appeared is reported as failed after this long. */
export const COPILOT_START_GRACE_MS = 60_000;
/** Statuses whose session is still live and polled by the worker loop. */
const ACTIVE_STATUSES = ["starting", "code", "cancelling"] as const;

const copilotRow = (workspaceId: string) =>
  and(
    eq(workspaceIntegrations.workspaceId, workspaceId),
    eq(workspaceIntegrations.kind, "copilot"),
  );

export async function getCopilotIntegration(ctx: Ctx, workspaceId: string) {
  const [row] = await ctx.db.select().from(workspaceIntegrations).where(copilotRow(workspaceId));
  return row ?? null;
}

/**
 * Upsert the Copilot row. With `keepCancelling`, a row the user is cancelling is left alone so a
 * late poll result cannot revive it.
 */
async function writeCopilot(
  ctx: Ctx,
  workspaceId: string,
  status: CopilotIntegrationStatus,
  detail: CopilotDetail,
  keepCancelling = false,
): Promise<void> {
  const values = { status, detail, observedAt: ctx.now() };
  await ctx.db
    .insert(workspaceIntegrations)
    .values({ workspaceId, kind: "copilot", ...values })
    .onConflictDoUpdate({
      target: [workspaceIntegrations.workspaceId, workspaceIntegrations.kind],
      set: values,
      ...(keepCancelling ? { setWhere: ne(workspaceIntegrations.status, "cancelling") } : {}),
    });
}

function detailOf(state: CopilotLoginState): CopilotDetail {
  return {
    ...(state.userCode ? { userCode: state.userCode } : {}),
    ...(state.verificationUri ? { verificationUri: state.verificationUri } : {}),
    ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}

/** Mirror an agent-reported session state into the row; sign-in also seeds the T3 provider. */
async function applyLoginState(
  ctx: Ctx,
  ws: WorkspaceRow,
  state: CopilotLoginState,
): Promise<void> {
  if (state.status === "signed_in") {
    const detail: CopilotDetail = { signedInAt: ctx.now().toISOString() };
    try {
      await ctx.agent.copilotProvider(ws.slug, true);
    } catch (e) {
      // Retried by reconcileCopilot on the next account sync; the sign-in itself succeeded.
      detail.providerError = errMessage(e);
    }
    await writeCopilot(ctx, ws.id, "signed_in", detail);
    return;
  }
  if (state.status === "idle") return;
  const terminal = COPILOT_TERMINAL_STATUSES.includes(state.status);
  await writeCopilot(
    ctx,
    ws.id,
    state.status as CopilotIntegrationStatus,
    terminal && state.status !== "failed" ? {} : detailOf(state),
    !terminal,
  );
}

/**
 * The `copilot_login` job: start `copilot login --device-code` in the (running) workspace and
 * record the first state. Short by design: following the session is `pollCopilotLogins`, so a
 * sign-in never occupies the workspace's job slot (stop/idle jobs must not wait for a human).
 */
export async function startCopilotLogin(ctx: Ctx, ws: WorkspaceRow): Promise<void> {
  if (ws.status !== "running") {
    await writeCopilot(ctx, ws.id, "failed", {
      error: "The workspace is not running. Start it, then sign in again.",
    });
    return;
  }
  try {
    await applyLoginState(ctx, ws, await ctx.agent.copilotLoginStart(ws.slug));
  } catch (e) {
    if (e instanceof AgentError && e.status !== null && e.status < 500) {
      await writeCopilot(ctx, ws.id, "failed", { error: e.message });
      return;
    }
    throw e;
  }
}

async function pollOne(ctx: Ctx, row: IntegrationRow, ws: WorkspaceRow): Promise<void> {
  const fail = (error: string) => writeCopilot(ctx, ws.id, "failed", { error });
  const now = ctx.now().getTime();
  if (ws.status !== "running") {
    await fail("The workspace stopped during sign-in. Start it, then sign in again.");
    return;
  }
  if (row.status === "cancelling") {
    await ctx.agent.copilotLoginCancel(ws.slug);
    await writeCopilot(ctx, ws.id, "cancelled", {});
    return;
  }
  let state: CopilotLoginState;
  try {
    state = await ctx.agent.copilotLoginState(ws.slug);
  } catch (e) {
    if (e instanceof AgentError && e.status === 409) {
      await fail("The workspace stopped during sign-in. Start it, then sign in again.");
      return;
    }
    // Transient agent trouble: keep the row; a code that has passed its expiry is still final.
    const expiresAt = copilotDetailSchema.parse(row.detail).expiresAt;
    if (row.status === "code" && expiresAt && Date.parse(expiresAt) <= now) {
      await writeCopilot(ctx, ws.id, "expired", {});
    }
    throw e;
  }
  if (state.status === "idle") {
    // The job may not have launched the session yet.
    if (row.status === "starting" && now - row.observedAt.getTime() < COPILOT_START_GRACE_MS)
      return;
    await fail("The sign-in session ended before it finished. Start it again.");
    return;
  }
  await applyLoginState(ctx, ws, state);
}

/** One pass over every live Copilot sign-in. Returns how many were examined. */
export async function pollCopilotLogins(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .select({ row: workspaceIntegrations, ws: workspaces })
    .from(workspaceIntegrations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceIntegrations.workspaceId))
    .where(
      and(
        eq(workspaceIntegrations.kind, "copilot"),
        inArray(workspaceIntegrations.status, [...ACTIVE_STATUSES]),
      ),
    );
  for (const { row, ws } of rows) {
    try {
      await pollOne(ctx, row, ws);
    } catch (e) {
      ctx.log.warn("copilot login poll failed", { ws: ws.slug, error: errMessage(e) });
    }
  }
  return rows.length;
}

export function startCopilotLoginLoop(ctx: Ctx): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    timer = undefined;
    pollCopilotLogins(ctx)
      .catch((e) => ctx.log.error("copilot login loop failed", { error: errMessage(e) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, COPILOT_POLL_INTERVAL_MS);
      });
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Bring the workspace's Copilot state in line with the DB (workspace must be running): finish a
 * requested sign-out, and keep the T3 provider seeded for a signed-in workspace. A Copilot login
 * the user made in a terminal (no row) is theirs and is never touched.
 */
export async function reconcileCopilot(ctx: Ctx, ws: WorkspaceRow): Promise<void> {
  const row = await getCopilotIntegration(ctx, ws.id);
  if (!row) return;
  if (row.status === "signing_out") {
    await ctx.agent.copilotLogout(ws.slug);
    await ctx.db.delete(workspaceIntegrations).where(copilotRow(ws.id));
    return;
  }
  if (row.status === "signed_in") {
    await ctx.agent.copilotProvider(ws.slug, true);
    const { providerError, ...rest } = copilotDetailSchema.parse(row.detail);
    if (providerError) await writeCopilot(ctx, ws.id, "signed_in", rest);
  }
}
