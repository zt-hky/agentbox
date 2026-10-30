"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { db } from "@agentbox/db/client";
import { guard, type ActionResult } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { reconcileAll, reconcileWorkspace, type BulkResult } from "@/lib/admin/toolchain-ops";
import { UserError } from "@/lib/errors";
import { refreshToolLatest, type RefreshResult } from "@/lib/toolchain/latest";

export async function refreshLatestAction(): Promise<ActionResult<RefreshResult>> {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const res = await refreshToolLatest(db, { actorId: admin.id, ip, force: true });
    revalidatePath("/admin/tools");
    return res;
  });
}

export async function reconcileWorkspaceAction(slug: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = wsSlugSchema.safeParse(slug);
    if (!parsed.success) throw new UserError("Workspace not found");
    const res = await reconcileWorkspace(db, { adminId: admin.id, ip }, parsed.data);
    revalidatePath("/admin/tools");
    return res;
  });
}

export async function reconcileAllAction(runningOnly: boolean): Promise<ActionResult<BulkResult>> {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const flag = z.boolean().safeParse(runningOnly);
    if (!flag.success) throw new UserError("Invalid request");
    const res = await reconcileAll(db, { adminId: admin.id, ip }, { runningOnly: flag.data });
    revalidatePath("/admin/tools");
    return res;
  });
}
