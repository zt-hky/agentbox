import { eq } from "drizzle-orm";
import { encrypt, randomToken } from "@agentbox/core";
import { creditBalances, plans, subscriptions, user, workspaces } from "@agentbox/db/schema";
import type { Db } from "../../src/types.ts";

export const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

export interface World {
  userId: string;
  email: string;
  workspaceId: string;
  slug: string;
  slot: number;
  secret: string;
  planId: string;
  subscriptionId: string;
}

export async function planByName(db: Db, name: string) {
  const [p] = await db.select().from(plans).where(eq(plans.name, name));
  if (!p) throw new Error(`seed plan ${name} missing`);
  return p;
}

export async function seedWorld(
  db: Db,
  o: {
    slug?: string;
    slot?: number;
    plan?: string;
    planId?: string;
    status?: (typeof workspaces.$inferInsert)["status"];
    balance?: bigint;
    access?: (typeof user.$inferInsert)["accessStatus"];
    now?: Date;
    cycleEnd?: Date;
    workspace?: Partial<typeof workspaces.$inferInsert>;
    subscription?: Partial<typeof subscriptions.$inferInsert>;
  } = {},
): Promise<World> {
  const slug = o.slug ?? "alice";
  const slot = o.slot ?? 1;
  const now = o.now ?? new Date();
  const planId = o.planId ?? (await planByName(db, o.plan ?? "Free trial")).id;
  const userId = `u_${slug}`;
  const email = `${slug}@example.com`;
  const secret = randomToken();
  await db.insert(user).values({
    id: userId,
    name: slug,
    email,
    emailVerified: true,
    accessStatus: o.access ?? "active",
  });
  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId,
      planId,
      cycleStart: now,
      cycleEnd: o.cycleEnd ?? new Date(now.getTime() + 30 * 86400_000),
      ...o.subscription,
    })
    .returning();
  await db.insert(creditBalances).values({ userId, balanceMicro: o.balance ?? 0n });
  const [ws] = await db
    .insert(workspaces)
    .values({
      userId,
      slug,
      slot,
      status: o.status ?? "running",
      identitySecretEnc: encrypt(secret, ENC_KEY),
      ...o.workspace,
    })
    .returning();
  return {
    userId,
    email,
    workspaceId: ws!.id,
    slug,
    slot,
    secret,
    planId,
    subscriptionId: sub!.id,
  };
}
