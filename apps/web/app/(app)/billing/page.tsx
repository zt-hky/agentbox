import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger } from "@agentbox/db/schema";
import { AllowanceBar } from "@/components/allowance-bar";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCredits } from "@/lib/money";
import { creditLabel, currentPrices } from "@/lib/queries";
import { requireActiveUser } from "@/lib/session";
import { loadBalance, loadSubscription } from "@/lib/user-data";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const { user } = await requireActiveUser();
  const [balance, sub, label, prices, ledger] = await Promise.all([
    loadBalance(user.id),
    loadSubscription(user.id),
    creditLabel(),
    currentPrices(),
    db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.id))
      .orderBy(desc(creditLedger.createdAt))
      .limit(100),
  ]);
  const rows: LedgerRow[] = ledger.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    reason: l.reason,
    deltaMicro: l.deltaMicro.toString(),
    note: l.note,
  }));

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Balance</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatCredits(balance, label)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardDescription>Prices</CardDescription>
            <CardTitle className="text-base">Charged once the plan allowance is used up</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {prices ? (
              <>
                <div className="flex justify-between">
                  <span>Runtime</span>
                  <span className="tabular-nums">
                    {formatCredits(prices.runtimePerHour, label)} / hour
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>CPU</span>
                  <span className="tabular-nums">
                    {formatCredits(prices.cpuCorePerHour, label)} / core-hour
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Memory</span>
                  <span className="tabular-nums">
                    {formatCredits(prices.memGbPerHour, label)} / GB-hour
                  </span>
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">No prices configured.</span>
            )}
          </CardContent>
        </Card>
      </div>

      {sub ? (
        <Card>
          <CardHeader>
            <CardTitle>Current cycle: {sub.plan.name}</CardTitle>
            <CardDescription>
              {sub.sub.cycleStart.toISOString().slice(0, 10)} to{" "}
              {sub.sub.cycleEnd.toISOString().slice(0, 10)}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <AllowanceBar
              label="Runtime"
              used={sub.sub.usedRuntimeHours}
              total={sub.plan.allowanceRuntimeHours}
              unit="h"
            />
            <AllowanceBar
              label="CPU"
              used={sub.sub.usedCpuCoreHours}
              total={sub.plan.allowanceCpuCoreHours}
              unit="core-h"
            />
            <AllowanceBar
              label="Memory"
              used={sub.sub.usedMemGbHours}
              total={sub.plan.allowanceMemGbHours}
              unit="GB-h"
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>Latest 100 entries</CardDescription>
        </CardHeader>
        <CardContent>
          <LedgerTable rows={rows} />
        </CardContent>
      </Card>
    </>
  );
}
