"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@agentbox/db/client";
import { plans, settings } from "@agentbox/db/schema";
import { parseSetting, type SettingKey } from "@agentbox/core/settings";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";

/** Validates with the core zod schema for `key`, upserts, and audits (before/after). */
export async function saveSetting(key: SettingKey, input: unknown) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    if (key !== "hibernation" && key !== "capacity" && key !== "billing") {
      throw new UserError("Unknown setting");
    }
    let value: unknown;
    try {
      value = parseSetting(key, input);
    } catch {
      throw new UserError("Invalid settings values");
    }
    await db.transaction(async (tx) => {
      if (key === "billing") {
        const planId = (value as { defaultPlanId: string }).defaultPlanId;
        const plan = (await tx.select().from(plans).where(eq(plans.id, planId)).limit(1))[0];
        if (!plan || !plan.active) throw new UserError("Default plan must be an active plan");
      }
      const before = (await tx.select().from(settings).where(eq(settings.key, key)).limit(1))[0];
      await tx
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "settings.update",
        targetType: "setting",
        targetId: key,
        metadata: { before: before?.value ?? null, after: value },
        ip,
      });
    });
    revalidatePath("/admin/settings");
  });
}
