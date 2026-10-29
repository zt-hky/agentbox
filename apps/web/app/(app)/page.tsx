import type { Metadata } from "next";
import { workspaceUrl } from "@agentbox/core/hosts";
import { AllowanceBar } from "@/components/allowance-bar";
import { StatusBadge } from "@/components/status-badge";
import { UsageChart } from "@/components/usage-chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { baseDomain } from "@/lib/env";
import { formatCredits } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { creditLabel } from "@/lib/queries";
import { requireActiveUser } from "@/lib/session";
import { loadBalance, loadHourlyUsage, loadSubscription, loadWorkspace } from "@/lib/user-data";
import { SleepButton } from "./sleep-button";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { user } = await requireActiveUser();
  const [workspace, subscription, balance, label] = await Promise.all([
    loadWorkspace(user.id),
    loadSubscription(user.id),
    loadBalance(user.id),
    creditLabel(),
  ]);
  const usage = workspace ? await loadHourlyUsage(workspace.id) : [];
  const domain = baseDomain();
  const usable = workspace && workspace.status !== "deleted" && workspace.status !== "deleting";

  return (
    <>
      <div className="grid gap-4 @container/main lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Workspace
              {workspace ? <StatusBadge status={workspace.status} /> : null}
            </CardTitle>
            <CardDescription>
              {workspace
                ? `${workspace.slug} · last activity ${formatDateTime(workspace.lastActivityAt)}`
                : "No workspace has been provisioned for your account yet."}
            </CardDescription>
          </CardHeader>
          {workspace && usable ? (
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild>
                <a
                  href={workspaceUrl(workspace.slug, "t3", domain)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open T3 Code
                </a>
              </Button>
              <Button asChild variant="secondary">
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
            </CardContent>
          ) : null}
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Credits</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatCredits(balance, label)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Top-ups are added by an administrator.
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan{subscription ? `: ${subscription.plan.name}` : ""}</CardTitle>
          <CardDescription>
            {subscription
              ? `Cycle ${subscription.sub.cycleStart.toISOString().slice(0, 10)} to ${subscription.sub.cycleEnd.toISOString().slice(0, 10)} · ${subscription.plan.cpuLimit} CPU · ${subscription.plan.memoryLimitMb} MB RAM · ${subscription.plan.diskLimitGb} GB disk`
              : "No active subscription."}
          </CardDescription>
        </CardHeader>
        {subscription ? (
          <CardContent className="grid gap-4 md:grid-cols-3">
            <AllowanceBar
              label="Runtime"
              used={subscription.sub.usedRuntimeHours}
              total={subscription.plan.allowanceRuntimeHours}
              unit="h"
            />
            <AllowanceBar
              label="CPU"
              used={subscription.sub.usedCpuCoreHours}
              total={subscription.plan.allowanceCpuCoreHours}
              unit="core-h"
            />
            <AllowanceBar
              label="Memory"
              used={subscription.sub.usedMemGbHours}
              total={subscription.plan.allowanceMemGbHours}
              unit="GB-h"
            />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage, last 7 days</CardTitle>
          <CardDescription>Per hour</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageChart data={usage} />
        </CardContent>
      </Card>
    </>
  );
}
