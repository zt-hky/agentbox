import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger } from "@agentbox/db/schema";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { PageHeader } from "@/components/page-header";
import { PlanCard } from "@/components/plan-card";
import { PlansComparison } from "@/components/plans-comparison";
import { Section } from "@/components/section";
import { Stat } from "@/components/stat";
import { formatCredits, formatVnd } from "@/lib/money";
import { billingDisplay, currentPrices, publicPlans } from "@/lib/queries";
import { requireActiveUser } from "@/lib/session";
import { loadBalance, loadSubscription } from "@/lib/user-data";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const { user } = await requireActiveUser();
  const [balance, sub, display, prices, plans, ledger] = await Promise.all([
    loadBalance(user.id),
    loadSubscription(user.id),
    billingDisplay(),
    currentPrices(),
    publicPlans(),
    db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.id))
      .orderBy(desc(creditLedger.createdAt))
      .limit(100),
  ]);
  const { label, creditValueVnd } = display;
  const now = new Date();
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
        description="Your plan's included runtime comes first. Past it, usage is drawn from your credit balance."
      />

      <div className="grid gap-8 md:grid-cols-[18rem_1fr]">
        <Stat
          label="Credit balance"
          value={formatCredits(balance, label, creditValueVnd)}
          hint={`1 ${label} = ${formatVnd(creditValueVnd)}. Top-ups are added by an administrator.`}
        />
        {sub ? (
          <PlanCard
            plan={sub.plan}
            sub={sub.sub}
            balanceMicro={balance}
            prices={prices}
            label={label}
            creditValueVnd={creditValueVnd}
            now={now}
          />
        ) : (
          <Section title="No plan yet">
            <p className="text-sm text-muted-foreground">
              An administrator assigns a plan when approving your account.
            </p>
          </Section>
        )}
      </div>

      <PlansComparison
        plans={plans}
        currentPlanId={sub?.plan.id ?? null}
        label={label}
        creditValueVnd={creditValueVnd}
      />

      <Section title="Ledger" description="Your latest 100 entries." bodyClassName="p-0">
        <LedgerTable rows={rows} />
      </Section>
    </>
  );
}
