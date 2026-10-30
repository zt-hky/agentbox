import { parseWorkspaceHost } from "@agentbox/core/hosts";
import { randomToken, hashToken } from "@agentbox/core/tokens";
import { handoffCodes } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";

export interface HandoffUser {
  id: string;
  role?: string | null;
  accessStatus?: string | null;
  /** `null` = has not finished onboarding (owners cannot open their workspace yet). */
  onboardedAt?: Date | null;
}
export interface HandoffWorkspace {
  id: string;
  userId: string;
  slug: string;
  status: string;
}

export type HandoffDecision =
  | { action: "issue"; host: string; ws: string }
  | { action: "confirm"; host: string; ws: string }
  | { action: "deny"; status: 400 | 403 | 404; reason: string };

/**
 * Pure authorization for `/auth/handoff`. `host` is the raw query value; it must be exactly
 * `<ws>-<svc>.<baseDomain>` (no port, no uppercase) for a known service.
 */
export function decideHandoff(input: {
  baseDomain: string;
  host: string | null | undefined;
  user: HandoffUser;
  workspace: HandoffWorkspace | null;
}): HandoffDecision {
  const { baseDomain, host, user, workspace } = input;
  if (!host) return { action: "deny", status: 400, reason: "Missing host" };
  if (user.accessStatus !== "active") {
    return { action: "deny", status: 403, reason: "Account is not active" };
  }
  const parsed = parseWorkspaceHost(host, baseDomain);
  if (!parsed || host !== `${parsed.ws}-${parsed.svc}.${baseDomain.toLowerCase()}`) {
    return { action: "deny", status: 400, reason: "Invalid workspace host" };
  }
  if (!workspace || workspace.slug !== parsed.ws || workspace.status === "deleted") {
    return { action: "deny", status: 404, reason: "Workspace not found" };
  }
  if (workspace.userId === user.id) {
    if (user.onboardedAt === null) {
      return {
        action: "deny",
        status: 403,
        reason: "Finish onboarding before opening your workspace",
      };
    }
    return { action: "issue", host, ws: parsed.ws };
  }
  if (user.role === "admin") return { action: "confirm", host, ws: parsed.ws };
  return { action: "deny", status: 403, reason: "Not your workspace" };
}

export const HANDOFF_TTL_MS = 60_000;

/** Insert a one-time code and return the URL to redirect the browser to. */
export async function issueHandoffCode(
  database: DbLike,
  input: { userId: string; workspaceId: string; host: string; returnPath: string; now?: Date },
): Promise<string> {
  const code = randomToken();
  const now = input.now ?? new Date();
  await database.insert(handoffCodes).values({
    codeHash: hashToken(code),
    userId: input.userId,
    workspaceId: input.workspaceId,
    host: input.host,
    returnPath: input.returnPath,
    expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
  });
  return `https://${input.host}/__abx/callback?code=${encodeURIComponent(code)}`;
}
