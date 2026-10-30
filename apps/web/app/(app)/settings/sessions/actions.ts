"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { workspaceSessions } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { requireOnboardedUser } from "@/lib/session";

export async function revokeSession(id: string) {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    const sessionId = z.uuid().parse(id);
    await db
      .update(workspaceSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workspaceSessions.id, sessionId),
          eq(workspaceSessions.userId, user.id),
          isNull(workspaceSessions.revokedAt),
        ),
      );
    revalidatePath("/settings/sessions");
  });
}

export async function revokeAllSessions() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    await db
      .update(workspaceSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceSessions.userId, user.id), isNull(workspaceSessions.revokedAt)));
    revalidatePath("/settings/sessions");
  });
}
