"use server";

import type { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@agentbox/db/client";
import { accessRequests, user } from "@agentbox/db/schema";
import { isUniqueViolation } from "@/lib/approve";
import { guard } from "@/lib/action";
import { checkSlugAvailable } from "@/lib/slug-taken";
import { UserError } from "@/lib/errors";
import { accessRequestSchema } from "@/lib/schemas";
import { requireUser } from "@/lib/session";

/** Live availability check for the workspace name field. */
export async function checkRequestedSlug(slug: string) {
  return guard(async () => {
    const session = await requireUser();
    const res = await checkSlugAvailable(db, slug.trim(), session.user.id);
    return res.ok ? { ok: true as const } : { ok: false as const, error: res.error };
  });
}

/** Opens a request (first time or after a rejection), or updates the note on the pending one. */
export async function submitAccessRequest(input: z.input<typeof accessRequestSchema>) {
  return guard(async () => {
    const session = await requireUser();
    const parsed = accessRequestSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    const message = parsed.data.message || null;
    const slug = parsed.data.slug;

    try {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({ accessStatus: user.accessStatus })
          .from(user)
          .where(eq(user.id, session.user.id))
          .for("update");
        const status = rows[0]?.accessStatus;
        if (status !== "none" && status !== "rejected" && status !== "pending") {
          throw new UserError("You cannot submit a request right now");
        }
        const slugCheck = await checkSlugAvailable(tx, slug, session.user.id);
        if (!slugCheck.ok) throw new UserError(slugCheck.error);
        const updated = await tx
          .update(accessRequests)
          .set({ message, requestedSlug: slug })
          .where(
            and(eq(accessRequests.userId, session.user.id), eq(accessRequests.status, "pending")),
          )
          .returning({ id: accessRequests.id });
        if (updated.length === 0) {
          await tx
            .insert(accessRequests)
            .values({ userId: session.user.id, message, requestedSlug: slug });
        }
        await tx.update(user).set({ accessStatus: "pending" }).where(eq(user.id, session.user.id));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new UserError(`"${slug}" is already taken`);
      throw e;
    }
    revalidatePath("/request-access");
  });
}
