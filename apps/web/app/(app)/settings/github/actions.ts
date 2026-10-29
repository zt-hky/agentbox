"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { decrypt } from "@agentbox/core/tokens";
import { db } from "@agentbox/db/client";
import { githubConnections, workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { encryptionKey, githubConnectConfig } from "@/lib/env";
import { revokeGrant } from "@/lib/github";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { requireActiveUser } from "@/lib/session";

export async function disconnectGithub() {
  return guard(async () => {
    const { user } = await requireActiveUser();
    const rows = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, user.id))
      .limit(1);
    const conn = rows[0];
    if (!conn) return;

    await db.transaction(async (tx) => {
      await tx.delete(githubConnections).where(eq(githubConnections.userId, user.id));
      const ws = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.userId, user.id))
        .limit(1);
      if (ws[0] && ws[0].status !== "deleted" && ws[0].status !== "deleting") {
        // The worker reconciles: no connection row -> agent disconnect (or pending flag if asleep).
        await enqueueWorkspaceJob(tx, ws[0].id, { type: "sync_github" });
      }
    });

    const cfg = githubConnectConfig();
    if (cfg) {
      try {
        await revokeGrant(cfg, decrypt(conn.tokenEnc, encryptionKey()));
      } catch (e) {
        console.error("github grant revoke failed", e);
      }
    }
    revalidatePath("/settings/github");
  });
}
