"use server";

import { redirect } from "next/navigation";
import { db } from "@agentbox/db/client";
import { writeAudit } from "@/lib/audit";
import { issueHandoffCode } from "@/lib/handoff";
import { decideForRequest } from "@/lib/handoff-server";
import { sanitizeReturnPath } from "@/lib/paths";
import { getClientIp, requireAdmin } from "@/lib/session";

/** Admin confirmed opening another user's workspace: audit, then continue the handoff. */
export async function confirmAdminOpen(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const host = String(formData.get("host") ?? "");
  const path = sanitizeReturnPath(String(formData.get("path") ?? "/"));
  const { decision, workspace } = await decideForRequest(host, session.user);
  if (decision.action === "deny" || !workspace) redirect("/admin/workspaces");

  const target = await db.transaction(async (tx) => {
    await writeAudit(tx, {
      actorId: session.user.id,
      action: "workspace.admin_open",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { slug: workspace.slug, host: decision.host, ownerId: workspace.userId },
      ip: await getClientIp(),
    });
    return issueHandoffCode(tx, {
      userId: session.user.id,
      workspaceId: workspace.id,
      host: decision.host,
      returnPath: path,
    });
  });
  redirect(target);
}
