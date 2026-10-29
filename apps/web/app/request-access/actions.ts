"use server";

import type { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@agentbox/db/client";
import { accessRequests, user } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { accessRequestSchema } from "@/lib/schemas";
import { requireUser } from "@/lib/session";

export async function submitAccessRequest(input: z.input<typeof accessRequestSchema>) {
  return guard(async () => {
    const session = await requireUser();
    const parsed = accessRequestSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");

    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ accessStatus: user.accessStatus })
        .from(user)
        .where(eq(user.id, session.user.id))
        .for("update");
      const status = rows[0]?.accessStatus;
      if (status !== "none" && status !== "rejected") {
        throw new UserError("You cannot submit a request right now");
      }
      const pending = await tx
        .select({ id: accessRequests.id })
        .from(accessRequests)
        .where(
          and(eq(accessRequests.userId, session.user.id), eq(accessRequests.status, "pending")),
        )
        .limit(1);
      if (pending.length === 0) {
        await tx.insert(accessRequests).values({
          userId: session.user.id,
          message: parsed.data.message || null,
        });
      }
      await tx.update(user).set({ accessStatus: "pending" }).where(eq(user.id, session.user.id));
    });
    revalidatePath("/request-access");
  });
}
