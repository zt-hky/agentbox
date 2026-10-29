import { eq, sql } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import {
  creditBalances,
  plans,
  subscriptions,
  usageSamples,
  workspaces,
} from "@agentbox/db/schema";

export async function loadWorkspace(userId: string) {
  const rows = await db.select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function loadSubscription(userId: string) {
  const rows = await db
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadBalance(userId: string): Promise<bigint> {
  const rows = await db
    .select({ b: creditBalances.balanceMicro })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);
  return rows[0]?.b ?? 0n;
}

export async function loadHourlyUsage(workspaceId: string) {
  const rows = await db.execute<{ hour: Date; runtime_sec: number; cpu_core_sec: number }>(sql`
    select date_trunc('hour', ${usageSamples.ts}) as hour,
           sum(${usageSamples.runtimeSec}) as runtime_sec,
           sum(${usageSamples.cpuCoreSec}) as cpu_core_sec
    from ${usageSamples}
    where ${usageSamples.workspaceId} = ${workspaceId}
      and ${usageSamples.ts} >= now() - interval '7 days'
    group by 1 order by 1`);
  return rows.rows.map((r) => ({
    hour: new Date(r.hour).toISOString(),
    runtimeMin: Math.round((Number(r.runtime_sec) / 60) * 10) / 10,
    cpuCoreMin: Math.round((Number(r.cpu_core_sec) / 60) * 10) / 10,
  }));
}
