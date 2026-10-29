import { desc, eq, sql } from "drizzle-orm";
import { db, readSetting } from "@agentbox/db/client";
import { accessRequests, plans, prices } from "@agentbox/db/schema";
import { microToCredits } from "./money";

export async function latestRequestFor(userId: string) {
  const rows = await db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.userId, userId))
    .orderBy(desc(accessRequests.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function creditLabel(): Promise<string> {
  const s = await readSetting(db, "billing");
  return s?.creditLabel ?? "credit";
}

/** Newest price row with `effective_from <= now()`. */
export async function currentPrices() {
  const rows = await db
    .select()
    .from(prices)
    .where(sql`${prices.effectiveFrom} <= now()`)
    .orderBy(desc(prices.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

export async function allPlans() {
  return db.select().from(plans).orderBy(plans.name);
}

/** Active plans for pickers, with a one-line summary, plus the configured default plan. */
export async function planOptions() {
  const [rows, billing] = await Promise.all([
    db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.name),
    readSetting(db, "billing"),
  ]);
  const label = billing?.creditLabel ?? "credit";
  const options = rows.map((p) => ({
    id: p.id,
    name: p.name,
    summary: [
      `${Number(p.cpuLimit)} CPU`,
      `${p.memoryLimitMb / 1024} GB RAM`,
      `${p.diskLimitGb} GB disk`,
      p.monthlyPriceMicro > 0n
        ? `${microToCredits(p.monthlyPriceMicro)} ${label}/month`
        : p.kind === "payg"
          ? "pay as you go"
          : "free",
    ].join(" · "),
  }));
  const defaultPlanId =
    billing && options.some((p) => p.id === billing.defaultPlanId)
      ? billing.defaultPlanId
      : (options[0]?.id ?? "");
  return { options, defaultPlanId };
}
