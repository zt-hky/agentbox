import { eq, sql } from "drizzle-orm";
import { creditBalances, creditLedger } from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db } from "./db-types";
import { UserError } from "./errors";
import { creditsToMicro } from "./money";

export interface AdjustCreditsInput {
  userId: string;
  /** Decimal credit amount, always positive. */
  amount: string;
  direction: "add" | "remove";
  note: string;
  actorId: string;
  ip: string | null;
}

/** `add` -> positive `admin_topup`; `remove` -> negative `adjustment`. Writes audit in the same tx. */
export async function adjustCredits(
  database: Db,
  input: AdjustCreditsInput,
): Promise<{ balanceMicro: bigint; deltaMicro: bigint }> {
  const note = input.note.trim();
  if (!note) throw new UserError("A note is required");
  const amountMicro = creditsToMicro(input.amount);
  const deltaMicro = input.direction === "add" ? amountMicro : -amountMicro;
  const reason = input.direction === "add" ? "admin_topup" : "adjustment";

  return database.transaction(async (tx) => {
    await tx.insert(creditBalances).values({ userId: input.userId }).onConflictDoNothing();
    const rows = await tx
      .select({ balanceMicro: creditBalances.balanceMicro })
      .from(creditBalances)
      .where(eq(creditBalances.userId, input.userId))
      .for("update");
    const current = rows[0]?.balanceMicro ?? 0n;
    const next = current + deltaMicro;
    if (next < 0n) throw new UserError("Balance would become negative");
    await tx
      .update(creditBalances)
      .set({ balanceMicro: sql`${creditBalances.balanceMicro} + ${deltaMicro.toString()}::bigint` })
      .where(eq(creditBalances.userId, input.userId));
    await tx.insert(creditLedger).values({
      userId: input.userId,
      deltaMicro,
      reason,
      note,
      actorId: input.actorId,
    });
    await writeAudit(tx, {
      actorId: input.actorId,
      action: input.direction === "add" ? "credits.topup" : "credits.adjust",
      targetType: "user",
      targetId: input.userId,
      metadata: { deltaMicro: deltaMicro.toString(), reason, note },
      ip: input.ip,
    });
    return { balanceMicro: next, deltaMicro };
  });
}
