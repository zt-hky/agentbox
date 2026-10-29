import { Check } from "lucide-react";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { formatCredits } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { InferSelectModel } from "drizzle-orm";
import type { plans } from "@agentbox/db/schema";

type Plan = InferSelectModel<typeof plans>;

const hours = (h: number) => `${+h.toFixed(1)} h`;
const minutes = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

function rows(p: Plan): [string, string][] {
  const trial = p.kind === "free";
  return [
    ["vCPU", String(Number(p.cpuLimit))],
    ["Memory", `${p.memoryLimitMb / 1024} GB`],
    ["Disk", `${p.diskLimitGb} GB`],
    [
      "Included runtime",
      p.allowanceRuntimeHours > 0
        ? `${hours(p.allowanceRuntimeHours)}${trial ? " in total" : " a month"}`
        : "none",
    ],
    [
      trial ? "Daily cap" : "Extra usage",
      trial
        ? p.dailyRuntimeHours === null
          ? "none"
          : `${hours(p.dailyRuntimeHours)} a day`
        : "billed in credits",
    ],
    ["Trial", p.trialDays ? `${p.trialDays} days` : "none"],
    ["Sleeps when idle", p.idleTimeoutMinutes === null ? "default" : minutes(p.idleTimeoutMinutes)],
    ["Max awake at once", p.maxAwakeHours === null ? "default" : hours(p.maxAwakeHours)],
  ];
}

/** Public plans side by side. There is no payment integration: upgrades go through an admin. */
export function PlansComparison({
  plans,
  currentPlanId,
  label,
  creditValueVnd,
}: {
  plans: Plan[];
  currentPlanId: string | null;
  label: string;
  creditValueVnd: number;
}) {
  return (
    <Section
      title="Plans"
      description="Upgrades are handled by an administrator: they take the first month from your credits and switch your plan."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = p.id === currentPlanId;
          const upgrade = !isCurrent && p.kind === "package" && p.monthlyPriceMicro > 0n;
          return (
            <article
              key={p.id}
              className={cn(
                "flex flex-col rounded-lg border bg-background p-4",
                isCurrent && "border-primary",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base">{p.name}</h3>
                {isCurrent ? <Badge variant="status">Your plan</Badge> : null}
              </div>
              <p className="mt-1 text-xl font-semibold tracking-tight">
                {p.monthlyPriceMicro > 0n
                  ? formatCredits(p.monthlyPriceMicro, label, creditValueVnd)
                  : "Free"}
              </p>
              <p className="text-meta text-muted-foreground">
                {p.monthlyPriceMicro > 0n
                  ? "per month"
                  : p.trialDays
                    ? `for ${p.trialDays} days`
                    : ""}
              </p>
              <dl className="mt-3 flex-1 text-sm">
                {rows(p).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-t py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 flex items-center gap-1.5 text-meta text-muted-foreground">
                {isCurrent ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" /> You are on this plan
                  </>
                ) : upgrade ? (
                  <span className="font-medium text-foreground">Ask an admin to upgrade</span>
                ) : (
                  ""
                )}
              </p>
            </article>
          );
        })}
      </div>
    </Section>
  );
}
