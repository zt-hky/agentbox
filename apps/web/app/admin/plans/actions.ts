"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, readSetting } from "@agentbox/db/client";
import { plans, subscriptions, workspaces } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { creditsToMicro } from "@/lib/money";
import { planSchema } from "@/lib/schemas";

const idSchema = z.uuid();

function planValues(input: z.output<typeof planSchema>) {
  return {
    name: input.name,
    kind: input.kind,
    monthlyPriceMicro: creditsToMicro(input.monthlyPrice, { allowZero: true }),
    cpuLimit: input.cpuLimit.toFixed(2),
    memoryLimitMb: input.memoryLimitMb,
    diskLimitGb: input.diskLimitGb,
    pidsLimit: input.pidsLimit,
    allowanceRuntimeHours: input.allowanceRuntimeHours,
    allowanceCpuCoreHours: input.allowanceCpuCoreHours,
    allowanceMemGbHours: input.allowanceMemGbHours,
    active: input.active,
  };
}

/** Create (`planId` null) or update a plan. Limit changes enqueue `update_limits` for subscribers. */
export async function savePlan(planId: string | null, input: z.input<typeof planSchema>) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = planSchema.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid input");
    const values = planValues(parsed.data);
    await db.transaction(async (tx) => {
      if (planId === null) {
        const row = (await tx.insert(plans).values(values).returning({ id: plans.id }))[0]!;
        await writeAudit(tx, {
          actorId: admin.id,
          action: "plan.create",
          targetType: "plan",
          targetId: row.id,
          metadata: { ...values, monthlyPriceMicro: values.monthlyPriceMicro.toString() },
          ip,
        });
        return;
      }
      const id = idSchema.parse(planId);
      const before = (await tx.select().from(plans).where(eq(plans.id, id)).for("update"))[0];
      if (!before) throw new UserError("Plan not found");
      const billing = await readSetting(tx, "billing");
      if (!values.active && billing?.defaultPlanId === id) {
        throw new UserError("The default plan cannot be deactivated");
      }
      await tx.update(plans).set(values).where(eq(plans.id, id));
      const limitsChanged =
        Number(before.cpuLimit) !== Number(values.cpuLimit) ||
        before.memoryLimitMb !== values.memoryLimitMb ||
        before.diskLimitGb !== values.diskLimitGb ||
        before.pidsLimit !== values.pidsLimit;
      if (limitsChanged) {
        const affected = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .innerJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
          .where(
            and(
              eq(subscriptions.planId, id),
              inArray(workspaces.status, ["sleeping", "starting", "running", "stopping", "error"]),
            ),
          );
        for (const w of affected) await enqueueWorkspaceJob(tx, w.id, { type: "update_limits" });
      }
      await writeAudit(tx, {
        actorId: admin.id,
        action: "plan.update",
        targetType: "plan",
        targetId: id,
        metadata: {
          before: { ...before, monthlyPriceMicro: before.monthlyPriceMicro.toString() },
          after: { ...values, monthlyPriceMicro: values.monthlyPriceMicro.toString() },
        },
        ip,
      });
    });
    revalidatePath("/admin/plans");
  });
}

/** Delete a plan nobody uses and that is not the default plan. */
export async function deletePlan(planId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const id = idSchema.parse(planId);
    await db.transaction(async (tx) => {
      const plan = (await tx.select().from(plans).where(eq(plans.id, id)).for("update"))[0];
      if (!plan) throw new UserError("Plan not found");
      const billing = await readSetting(tx, "billing");
      if (billing?.defaultPlanId === id) throw new UserError("The default plan cannot be deleted");
      const used = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.planId, id))
        .limit(1);
      if (used.length > 0) {
        throw new UserError("Plan has subscribers; deactivate it instead of deleting");
      }
      await tx.delete(plans).where(eq(plans.id, id));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "plan.delete",
        targetType: "plan",
        targetId: id,
        metadata: { name: plan.name },
        ip,
      });
    });
    revalidatePath("/admin/plans");
  });
}
