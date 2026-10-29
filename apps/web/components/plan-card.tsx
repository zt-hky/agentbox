import { AllowanceMeters } from "@/components/allowance-meters";
import { KeyValueList } from "@/components/key-value-list";
import { Notice } from "@/components/notice";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { formatCredits } from "@/lib/money";
import { gateMessage, planStatus } from "@/lib/plan-status";
import type { InferSelectModel } from "drizzle-orm";
import type { plans, prices, subscriptions } from "@agentbox/db/schema";

type Plan = InferSelectModel<typeof plans>;
type Sub = InferSelectModel<typeof subscriptions>;
type Prices = InferSelectModel<typeof prices>;

const hoursText = (h: number) => `${+h.toFixed(1)} h`;

/** The user's plan: trial/daily countdown, included runtime left, extra-usage rates, balance. */
export function PlanCard({
  plan,
  sub,
  balanceMicro,
  prices,
  label,
  creditValueVnd,
  now,
  showRates = true,
}: {
  plan: Plan;
  sub: Sub;
  balanceMicro: bigint;
  prices: Prices | null;
  label: string;
  creditValueVnd: number;
  now: Date;
  showRates?: boolean;
}) {
  const status = planStatus({ plan, sub, balanceMicro, now });
  const blocked = gateMessage(status.gate, plan);
  const price = plan.monthlyPriceMicro;
  const countdown = [status.trialText, status.dailyText].filter(Boolean).join(", ");
  return (
    <Section
      title={
        <span className="flex flex-wrap items-center gap-2">
          {plan.name}
          {plan.kind === "free" && sub.trialEndsAt ? <Badge variant="status">Trial</Badge> : null}
        </span>
      }
      description={
        price > 0n
          ? `${formatCredits(price, label, creditValueVnd)} a month. Cycle ${formatDate(sub.cycleStart)} to ${formatDate(sub.cycleEnd)}.`
          : plan.kind === "payg"
            ? "No monthly fee. Everything you run is paid from your credits."
            : `Cycle ${formatDate(sub.cycleStart)} to ${formatDate(sub.cycleEnd)}.`
      }
    >
      <div className="space-y-5">
        {countdown ? (
          <p className="text-xl font-semibold tracking-tight" data-testid="plan-countdown">
            {countdown}
          </p>
        ) : null}
        {blocked ? <Notice>{blocked}</Notice> : null}
        {plan.allowanceRuntimeHours > 0 ? (
          <>
            <AllowanceMeters used={sub} plan={plan} />
            <p className="text-meta text-muted-foreground">
              {hoursText(status.runtimeLeftHours ?? 0)} of included runtime left this cycle.
              {plan.kind === "free"
                ? " The trial has no extra usage: the workspace stops when it is used up."
                : " Past it, usage is billed in credits."}
            </p>
          </>
        ) : null}
        <KeyValueList
          items={[
            {
              label: "Machine",
              value: `${Number(plan.cpuLimit)} vCPU · ${plan.memoryLimitMb / 1024} GB RAM · ${plan.diskLimitGb} GB disk`,
            },
            {
              label: "Credit balance",
              value: formatCredits(balanceMicro, label, creditValueVnd),
            },
            ...(showRates && prices
              ? [
                  {
                    label: plan.kind === "free" ? "Credits: runtime" : "Extra runtime",
                    value: `${formatCredits(prices.runtimePerHour, label, creditValueVnd)} per hour`,
                  },
                  {
                    label: plan.kind === "free" ? "Credits: CPU" : "Extra CPU",
                    value: `${formatCredits(prices.cpuCorePerHour, label, creditValueVnd)} per core-hour`,
                  },
                  {
                    label: plan.kind === "free" ? "Credits: memory" : "Extra memory",
                    value: `${formatCredits(prices.memGbPerHour, label, creditValueVnd)} per GB-hour`,
                  },
                ]
              : []),
          ]}
        />
      </div>
    </Section>
  );
}
