"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { getClientIp, requireOnboardedUser } from "@/lib/session";
import { deleteOwnWorkspace, restartOwnWorkspace } from "@/lib/user-lifecycle";

const deleteInput = z.object({ keepData: z.boolean(), confirmSlug: z.string().min(1).max(64) });

export async function sleepNow() {
  return guard(async () => {
    const session = await requireOnboardedUser();
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

export async function restartNow() {
  return guard(async () => {
    const session = await requireOnboardedUser();
    await restartOwnWorkspace(db, { userId: session.user.id, ip: await getClientIp() });
    revalidatePath("/");
  });
}

export async function deleteWorkspaceAction(input: unknown) {
  return guard(async () => {
    const session = await requireOnboardedUser();
    const parsed = deleteInput.safeParse(input);
    if (!parsed.success) throw new UserError("Invalid input");
    await deleteOwnWorkspace(db, { userId: session.user.id, ip: await getClientIp() }, parsed.data);
    revalidatePath("/", "layout");
    return { redirectTo: "/onboarding" as const };
  });
}
