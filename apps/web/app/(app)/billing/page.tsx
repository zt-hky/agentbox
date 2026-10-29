import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger } from "@agentbox/db/schema";
import { AllowanceMeters } from "@/components/allowance-meters";
import { KeyValueList } from "@/components/key-value-list";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Stat } from "@/components/stat";
import { formatDate } from "@/lib/format";
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
      <PageHeader
        title="Billing"
        description="Your plan allowance comes first. Once it is used up, the workspace draws from your credit balance."
      />

      <div className="grid gap-8 md:grid-cols-[16rem_1fr]">
        <Stat
          label="Credit balance"
          value={formatCredits(balance, label)}
          hint="Top-ups are added by an administrator."
        />
        <Section title="Prices after the allowance" bodyClassName="py-4">
          {prices ? (
            <KeyValueList
              items={[
                {
                  label: "Runtime",
                  value: `${formatCredits(prices.runtimePerHour, label)} per hour`,
                },
                {
                  label: "CPU",
                  value: `${formatCredits(prices.cpuCorePerHour, label)} per core-hour`,
                },
                {
                  label: "Memory",
                  value: `${formatCredits(prices.memGbPerHour, label)} per GB-hour`,
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No prices are configured yet, so nothing is charged.
            </p>
          )}
        </Section>
      </div>

      {sub ? (
        <Section
          title={`${sub.plan.name} plan`}
          description={`Current cycle: ${formatDate(sub.sub.cycleStart)} to ${formatDate(sub.sub.cycleEnd)}.`}
        >
          <AllowanceMeters used={sub.sub} plan={sub.plan} />
        </Section>
      ) : null}

      <Section title="Ledger" description="Your latest 100 entries." bodyClassName="p-0">
        <LedgerTable rows={rows} />
      </Section>
    </>
  );
}
