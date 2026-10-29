"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@agentbox/db/client";
import { accessRequests, user } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { approveAccessRequest } from "@/lib/approve";
import { writeAudit } from "@/lib/audit";
import { encryptionKey } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { approveSchema, rejectSchema } from "@/lib/schemas";
import type { z } from "zod";

export async function approveRequest(input: z.input<typeof approveSchema>) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = approveSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    const result = await approveAccessRequest(db, {
      requestId: parsed.data.requestId,
      adminId: admin.id,
      slug: parsed.data.slug,
      planId: parsed.data.planId,
      encryptionKey: encryptionKey(),
      ip,
    });
    revalidatePath("/admin/requests");
    return { slug: parsed.data.slug, slot: result.slot };
  });
}

export async function rejectRequest(input: z.input<typeof rejectSchema>) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = rejectSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, parsed.data.requestId))
        .for("update");
      const request = rows[0];
      if (!request) throw new UserError("Request not found");
      if (request.status !== "pending") throw new UserError("Request was already decided");
      await tx
        .update(accessRequests)
        .set({
          status: "rejected",
          decidedBy: admin.id,
          decidedAt: new Date(),
          reason: parsed.data.reason,
        })
        .where(eq(accessRequests.id, request.id));
      await tx.update(user).set({ accessStatus: "rejected" }).where(eq(user.id, request.userId));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "access.reject",
        targetType: "user",
        targetId: request.userId,
        metadata: { requestId: request.id, reason: parsed.data.reason },
        ip,
      });
    });
    revalidatePath("/admin/requests");
  });
}
