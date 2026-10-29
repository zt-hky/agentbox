import { eq } from "drizzle-orm";
import { parseWorkspaceHost } from "@agentbox/core/hosts";
import { db } from "@agentbox/db/client";
import { workspaces } from "@agentbox/db/schema";
import { baseDomain } from "./env";
import { decideHandoff, type HandoffDecision, type HandoffUser } from "./handoff";

export async function decideForRequest(
  host: string | null,
  user: HandoffUser,
): Promise<{ decision: HandoffDecision; workspace: typeof workspaces.$inferSelect | null }> {
  const domain = baseDomain();
  const parsed = host ? parseWorkspaceHost(host, domain) : null;
  let workspace: typeof workspaces.$inferSelect | null = null;
  if (parsed) {
    const rows = await db.select().from(workspaces).where(eq(workspaces.slug, parsed.ws)).limit(1);
    workspace = rows[0] ?? null;
  }
  return { decision: decideHandoff({ baseDomain: domain, host, user, workspace }), workspace };
}
