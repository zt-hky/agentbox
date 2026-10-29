import { desc, eq, sql } from "drizzle-orm";
import { db, readSetting } from "@agentbox/db/client";
import { accessRequests, plans, prices } from "@agentbox/db/schema";

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
