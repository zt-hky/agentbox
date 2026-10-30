import type { Db } from "@agentbox/db/client";
import {
  creditBalances,
  plans,
  subscriptions,
  toolLatest,
  workspaces,
  workspaceTools,
} from "@agentbox/db/schema";
import { seedUser } from "./db";

let n = 0;

export const PYTHON_VERSIONS = ["3.14.2", "3.13.9", "3.12.16", "3.12.9", "3.12.1", "3.11.14"];
export const NODE_VERSIONS = ["26.13.0", "25.9.0", "24.22.2", "24.20.0", "22.20.0"];

/** Published versions for a few tools, as the refresher would store them. */
export async function seedLatest(db: Db) {
  await db
    .insert(toolLatest)
    .values([
      {
        toolId: "node",
        latest: "26.13.0",
        lts: "24.22.2",
        versions: NODE_VERSIONS,
        checkedAt: new Date(),
      },
      {
        toolId: "python",
        latest: "3.14.2",
        lts: null,
        versions: PYTHON_VERSIONS,
        checkedAt: new Date(),
      },
      {
        toolId: "bun",
        latest: "1.3.2",
        lts: null,
        versions: ["1.3.2", "1.3.1", "1.2.9"],
        checkedAt: new Date(),
      },
      {
        toolId: "claude",
        latest: "2.1.314",
        lts: null,
        versions: ["2.1.314", "2.1.300", "2.0.9"],
        checkedAt: new Date(),
      },
    ])
    .onConflictDoNothing();
}

/**
 * A user with a workspace and a plan. `billing: "ok"` gives credits; `"empty"` is a credits-only
 * plan with no balance (the workspace cannot wake).
 */
export async function seedTenant(
  db: Db,
  opts: {
    status?: (typeof workspaces.$inferInsert)["status"];
    billing?: "ok" | "empty";
    access?: "active" | "suspended";
  } = {},
) {
  n++;
  const userId = await seedUser(db, `tool${n}@example.com`, opts.access ?? "active");
  const [ws] = await db
    .insert(workspaces)
    .values({
      userId,
      slug: `tool${n}x`,
      slot: 5000 + n,
      status: opts.status ?? "running",
      identitySecretEnc: "x",
    })
    .returning();
  const [plan] = await db
    .insert(plans)
    .values({ name: `t${n}`, kind: "payg", cpuLimit: "1", memoryLimitMb: 1024, diskLimitGb: 10 })
    .returning();
  const now = new Date();
  await db.insert(subscriptions).values({
    userId,
    planId: plan!.id,
    cycleStart: now,
    cycleEnd: new Date(now.getTime() + 864e5),
  });
  if ((opts.billing ?? "ok") === "ok") {
    await db.insert(creditBalances).values({ userId, balanceMicro: 5_000_000n });
  }
  return { userId, ws: ws! };
}

/** Mark a tool as installed and managed in a workspace. */
export async function markInstalled(
  db: Db,
  workspaceId: string,
  toolId: string,
  set: Partial<typeof workspaceTools.$inferInsert> & { installedVersion: string },
) {
  await db
    .insert(workspaceTools)
    .values({
      workspaceId,
      toolId,
      desired: true,
      state: "idle",
      backend: toolId,
      ...set,
    })
    .onConflictDoUpdate({
      target: [workspaceTools.workspaceId, workspaceTools.toolId],
      set: { desired: true, state: "idle", backend: toolId, ...set },
    });
}
