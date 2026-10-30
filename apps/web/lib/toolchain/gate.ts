import { eq } from "drizzle-orm";
import { BILLING_TIME_ZONE, planGate } from "@agentbox/core/billing";
import { creditBalances, plans, subscriptions, user } from "@agentbox/db/schema";
import type { DbLike } from "../db-types";
import { UserError } from "../errors";
import { gateMessage } from "../plan-status";

/** Workspace states in which a toolchain run can be requested (the worker starts a sleeping one). */
export const TOOLCHAIN_WORKSPACE_STATUSES = [
  "sleeping",
  "starting",
  "running",
  "stopping",
  "error",
] as const;

/** Statuses in which the workspace is already awake, so applying costs nothing extra. */
const AWAKE_STATUSES = ["running", "starting"];

/**
 * Throws a UserError with the reason when a toolchain run for `userId`'s workspace must not be
 * queued: the account is suspended, or the workspace is asleep and the plan cannot wake it
 * (applying starts the workspace and is billed as normal awake time).
 */
export async function assertCanApplyToolchain(
  database: DbLike,
  input: { userId: string; workspaceStatus: string; now?: Date },
): Promise<void> {
  const [account] = await database
    .select({ accessStatus: user.accessStatus })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (account?.accessStatus === "suspended") {
    throw new UserError("This account is suspended. Ask an administrator to restore access.");
  }
  if (AWAKE_STATUSES.includes(input.workspaceStatus)) return;

  const [row] = await database
    .select({ plan: plans, sub: subscriptions, balance: creditBalances.balanceMicro })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .leftJoin(creditBalances, eq(creditBalances.userId, subscriptions.userId))
    .where(eq(subscriptions.userId, input.userId))
    .limit(1);
  if (!row) {
    throw new UserError(
      "The workspace is asleep and this account has no plan, so it cannot be started to apply changes.",
    );
  }
  const gate = planGate({
    plan: row.plan,
    subscription: row.sub,
    balanceMicro: row.balance ?? 0n,
    now: input.now ?? new Date(),
    timeZone: BILLING_TIME_ZONE,
  });
  const message = gateMessage(gate, row.plan);
  if (message) {
    throw new UserError(
      `The workspace is asleep and cannot be started to apply changes. ${message}`,
    );
  }
}
