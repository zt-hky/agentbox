"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@agentbox/db/client";
import { workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { requireActiveUser } from "@/lib/session";

export async function sleepNow() {
  return guard(async () => {
    const session = await requireActiveUser();
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.userId, session.user.id),
          inArray(workspaces.status, ["running", "starting"]),
        ),
      )
      .limit(1);
    const ws = rows[0];
    if (!ws) throw new UserError("Your workspace is not running");
    await enqueueWorkspaceJob(db, ws.id, { type: "stop_workspace", reason: "user" });
    revalidatePath("/");
  });
}
