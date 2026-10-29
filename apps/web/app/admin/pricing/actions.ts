"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { db } from "@agentbox/db/client";
import { prices } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { creditsToMicro } from "@/lib/money";
import { priceSchema } from "@/lib/schemas";

/** Prices are versioned: a new row takes effect immediately; old rows stay as history. */
export async function createPriceVersion(input: z.input<typeof priceSchema>) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = priceSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    const values = {
      runtimePerHour: creditsToMicro(parsed.data.runtimePerHour, { allowZero: true }),
      cpuCorePerHour: creditsToMicro(parsed.data.cpuCorePerHour, { allowZero: true }),
      memGbPerHour: creditsToMicro(parsed.data.memGbPerHour, { allowZero: true }),
    };
    await db.transaction(async (tx) => {
      const row = (await tx.insert(prices).values(values).returning({ id: prices.id }))[0]!;
      await writeAudit(tx, {
        actorId: admin.id,
        action: "pricing.create",
        targetType: "price",
        targetId: row.id,
        metadata: {
          runtimePerHourMicro: values.runtimePerHour.toString(),
          cpuCorePerHourMicro: values.cpuCorePerHour.toString(),
          memGbPerHourMicro: values.memGbPerHour.toString(),
        },
        ip,
      });
    });
    revalidatePath("/admin/pricing");
  });
}
