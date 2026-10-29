import { and, desc, eq, sql } from "drizzle-orm";
import { db, readSetting } from "@agentbox/db/client";
import { accessRequests, plans, prices } from "@agentbox/db/schema";
import { FREE_PLAN_ID } from "@agentbox/core/billing";
import { formatCredits } from "./money";

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

/** Credit label and the dong value of one credit, for display. */
export async function billingDisplay(): Promise<{ label: string; creditValueVnd: number }> {
  const s = await readSetting(db, "billing");
  return { label: s?.creditLabel ?? "credit", creditValueVnd: s?.creditValueVnd ?? 1000 };
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
  return db.select().from(plans).orderBy(plans.sortOrder, plans.name);
}

/** Active, public plans for the user-facing comparison, in display order. */
export async function publicPlans() {
  return db
    .select()
    .from(plans)
    .where(and(eq(plans.active, true), eq(plans.public, true)))
    .orderBy(plans.sortOrder, plans.name);
}

/**
 * Active plans for admin pickers (internal plans included), with a one-line summary. The default
 * is the Free trial when it is active, else the configured default plan.
 */
export async function planOptions() {
  const [rows, billing] = await Promise.all([
    db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.sortOrder, plans.name),
    readSetting(db, "billing"),
  ]);
  const label = billing?.creditLabel ?? "credit";
  const valueVnd = billing?.creditValueVnd ?? 1000;
  const options = rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    public: p.public,
    monthlyPriceMicro: p.monthlyPriceMicro.toString(),
    summary: [
      `${Number(p.cpuLimit)} vCPU`,
      `${p.memoryLimitMb / 1024} GB RAM`,
      `${p.diskLimitGb} GB disk`,
      p.monthlyPriceMicro > 0n
        ? `${formatCredits(p.monthlyPriceMicro, label, valueVnd)}/month`
        : p.kind === "payg"
          ? "credits only"
          : p.trialDays
            ? `${p.trialDays}-day trial`
            : "free",
    ].join(" · "),
  }));
  const pick = (id: string | undefined) => options.find((p) => p.id === id)?.id;
  const defaultPlanId = pick(FREE_PLAN_ID) ?? pick(billing?.defaultPlanId) ?? options[0]?.id ?? "";
  return { options, defaultPlanId };
}
