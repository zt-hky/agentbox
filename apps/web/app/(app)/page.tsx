import type { Metadata } from "next";
import Link from "next/link";
import { workspaceUrl } from "@agentbox/core/hosts";
import { EmptyState } from "@/components/empty-state";
import { Mono } from "@/components/mono";
import { PageHeader } from "@/components/page-header";
import { PlanCard } from "@/components/plan-card";
import { Section } from "@/components/section";
import { Stat } from "@/components/stat";
import { UsageChart } from "@/components/usage-chart";
import { WorkspaceModule } from "@/components/workspace-module";
import { Button } from "@/components/ui/button";
import { db } from "@agentbox/db/client";
import { baseDomain } from "@/lib/env";
import { formatCredits, formatVnd } from "@/lib/money";
import { billingDisplay, currentPrices, effectiveIdleTimeoutMinutes } from "@/lib/queries";
import { requireActiveUser } from "@/lib/session";
import {
  loadBalance,
  loadHourlyUsage,
  loadLiveReading,
  loadSubscription,
  loadWorkspace,
} from "@/lib/user-data";
import { loadDashboardToolSummary } from "@/lib/dashboard";
import { SleepButton } from "./sleep-button";
import { ToolsSummary } from "./tools-summary";
import { DeleteWorkspaceButton, RestartButton } from "./workspace-controls";

export const metadata: Metadata = { title: "Dashboard" };

const MB = 1024 * 1024;
const GB = 1024 * MB;

export default async function DashboardPage() {
  const { user } = await requireActiveUser();
  const [workspace, subscription, balance, display, prices] = await Promise.all([
    loadWorkspace(user.id),
    loadSubscription(user.id),
    loadBalance(user.id),
    billingDisplay(),
    currentPrices(),
  ]);
  const { label, creditValueVnd } = display;
  const idleTimeoutMinutes = await effectiveIdleTimeoutMinutes(
    subscription?.plan.idleTimeoutMinutes ?? null,
  );
  const [usage, live, toolSummary] = workspace
    ? await Promise.all([
        loadHourlyUsage(workspace.id),
        loadLiveReading(workspace),
        loadDashboardToolSummary(db, user.id),
      ])
    : [[], null, null];
  const domain = baseDomain();
  const usable = workspace && workspace.status !== "deleted" && workspace.status !== "deleting";
  const now = new Date();
  const limits = subscription
    ? {
        cpus: Number(subscription.plan.cpuLimit),
        memBytes: subscription.plan.memoryLimitMb * MB,
        diskBytes: subscription.plan.diskLimitGb * GB,
      }
    : null;

  return (
    <>
      <PageHeader
        title="Your workspace"
        description="Open your tools, see whether the machine is awake, and check what is left this cycle."
      />

      {workspace && usable ? (
        <WorkspaceModule
          variant="hero"
          ws={{
            slug: workspace.slug,
            status: workspace.status,
            plan: subscription?.plan.name ?? null,
            lastActivityAt: workspace.lastActivityAt,
            awakeSince: workspace.awakeSince,
            idleTimeoutMinutes,
          }}
          live={live}
          limits={limits}
          now={now}
          actions={
            <>
              <Button asChild size="lg">
                <a
                  href={workspaceUrl(workspace.slug, "t3", domain)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open T3 Code
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a
                  href={workspaceUrl(workspace.slug, "code", domain)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open VS Code
                </a>
              </Button>
              {workspace.status === "running" || workspace.status === "starting" ? (
                <SleepButton />
              ) : null}
            </>
          }
        />
      ) : (
        <EmptyState
          title="No workspace yet"
          description="Your workspace is created during setup. Reload this page; if it stays empty, an administrator can check your account."
        />
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        {subscription ? (
          <PlanCard
            plan={subscription.plan}
            sub={subscription.sub}
            balanceMicro={balance}
            prices={prices}
            label={label}
            creditValueVnd={creditValueVnd}
            now={now}
          />
        ) : (
          <Section title="Your plan">
            <p className="text-sm text-muted-foreground">
              You have no active subscription yet. An administrator assigns a plan when approving
              your account.
            </p>
          </Section>
        )}
        <div className="flex flex-col justify-between gap-4 py-1">
          <Stat
            label="Credit balance"
            value={formatCredits(balance, label, creditValueVnd)}
            hint={`1 ${label} = ${formatVnd(creditValueVnd)}. Spent after your included runtime; top-ups come from an administrator.`}
          />
          <Button asChild variant="outline" size="sm" className="self-start">
            <Link href="/billing">Plans and billing</Link>
          </Button>
        </div>
      </div>

      <Section
        title="Usage, last 7 days"
        description="Hours the workspace ran and CPU time it used, per day (UTC)."
      >
        {usage.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No usage yet. It shows up here after your workspace has been awake.
          </p>
        ) : (
          <UsageChart data={usage} endDate={now.toISOString()} />
        )}
      </Section>

      {toolSummary ? <ToolsSummary summary={toolSummary} /> : null}

      {workspace && usable ? (
        <Section
          title="Manage workspace"
          description={
            <>
              Your files live in <Mono>/workspace</Mono> and stay when the workspace sleeps or
              restarts.
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            {["running", "sleeping", "error"].includes(workspace.status) ? <RestartButton /> : null}
            <DeleteWorkspaceButton slug={workspace.slug} />
          </div>
        </Section>
      ) : null}
    </>
  );
}
