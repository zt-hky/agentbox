import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { ports, tenantUid } from "@agentbox/core/slots";
import { db } from "@agentbox/db/client";
import {
  hostStats,
  jobs,
  plans,
  subscriptions,
  usageSamples,
  user,
  workspaceEvents,
  workspaces,
} from "@agentbox/db/schema";
import { KeyValueList } from "@/components/key-value-list";
import { Meter } from "@/components/meter";
import { Mono } from "@/components/mono";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { statusLabel } from "@/components/status-light";
import { Notice } from "@/components/notice";
import { Timeline } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import {
  cpuCoresFromFreshSample,
  indexHostStats,
  linuxUser,
  parseUsageRange,
  planLimits,
  uptimeSec,
  USAGE_RANGES,
  type JobView,
} from "@/lib/admin/workspaces";
import { latestDiagnostics, loadUsageSeries, toJobView } from "@/lib/admin/workspaces-ops";
import { baseDomain } from "@/lib/env";
import { formatAgo, formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import { planOptions } from "@/lib/queries";
import { requireAdmin } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DiagnosticPanel } from "./diagnostics";
import { JobsTable } from "./jobs-table";
import { TabNav, parseTab } from "./tab-nav";
import { UsageCharts } from "./usage-charts";
import { ManagePanel } from "./workspace-controls";

export const metadata: Metadata = { title: "Workspace" };
export const dynamic = "force-dynamic";

type Search = { tab?: string; range?: string };

const EVENT_LIGHT: Record<string, string> = {
  started: "running",
  stopped: "sleeping",
  crashed: "error",
  oom: "error",
  start_failed: "error",
  policy_violation: "error",
  credits_exhausted: "starting",
};

export default async function AdminWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  await requireAdmin();
  const { slug } = await params;
  const search = await searchParams;
  const tab = parseTab(search.tab);
  const now = new Date();

  const row = (
    await db
      .select({ w: workspaces, u: user, plan: plans })
      .from(workspaces)
      .innerJoin(user, eq(user.id, workspaces.userId))
      .leftJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(workspaces.slug, slug))
      .limit(1)
  )[0];
  if (!row) notFound();
  const { w, u, plan } = row;
  const domain = baseDomain();
  const openable = w.status !== "deleted" && w.status !== "deleting";
  const running = w.status === "running";
  const planChoices = w.status === "deleted" ? await planOptions() : null;
  const recreate = planChoices
    ? {
        plans: planChoices.options,
        defaultPlanId: plan?.id ?? planChoices.defaultPlanId,
        baseDomain: domain,
      }
    : null;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Mono className="font-semibold">{w.slug}</Mono>
            <StatusBadge status={w.status} />
          </span>
        }
        description={
          <>
            Owned by{" "}
            <Link
              className="text-signal underline-offset-4 hover:underline"
              href={`/admin/users/${u.id}`}
            >
              {u.email}
            </Link>
            {plan ? `, on the ${plan.name} plan.` : ", with no plan."}
          </>
        }
        actions={
          openable ? (
            <>
              <Button asChild variant="outline" size="sm">
                <a href={`/auth/handoff?host=${w.slug}-t3.${domain}&path=/`}>
                  Open T3 Code as admin
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={`/auth/handoff?host=${w.slug}-code.${domain}&path=/`}>
                  Open VS Code as admin
                </a>
              </Button>
            </>
          ) : null
        }
      />
      <TabNav slug={w.slug} current={tab} />
      {tab === "overview" ? (
        <OverviewTab w={w} plan={plan} domain={domain} now={now} />
      ) : tab === "usage" ? (
        <UsageTab
          workspaceId={w.id}
          plan={plan}
          rangeParam={search.range}
          slug={w.slug}
          now={now}
        />
      ) : tab === "processes" || tab === "logs" ? (
        <DiagnosticsTab slug={w.slug} workspaceId={w.id} kind={tab} running={running} now={now} />
      ) : tab === "events" ? (
        <EventsTab workspaceId={w.id} />
      ) : tab === "jobs" ? (
        <JobsTab workspaceId={w.id} />
      ) : (
        <Section title="Manage" description="Every action here is recorded in the audit log.">
          <ManagePanel
            slug={w.slug}
            status={w.status}
            startFailures={w.startFailures}
            ownerId={u.id}
            ownerEmail={u.email}
            planName={plan?.name ?? null}
            recreate={recreate}
          />
        </Section>
      )}
    </>
  );
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type PlanRow = typeof plans.$inferSelect | null;

async function OverviewTab({
  w,
  plan,
  domain,
  now,
}: {
  w: WorkspaceRow;
  plan: PlanRow;
  domain: string;
  now: Date;
}) {
  const [stats, sample] = await Promise.all([
    db.select().from(hostStats).where(eq(hostStats.id, 1)).limit(1),
    db
      .select({
        ts: usageSamples.ts,
        cpuCoreSec: usageSamples.cpuCoreSec,
        runtimeSec: usageSamples.runtimeSec,
      })
      .from(usageSamples)
      .where(eq(usageSamples.workspaceId, w.id))
      .orderBy(desc(usageSamples.ts))
      .limit(1),
  ]);
  const index = indexHostStats(stats[0]?.payload, stats[0]?.updatedAt, now);
  const host = index?.byWorkspace.get(w.slug);
  const limits = plan ? planLimits(plan) : null;
  const running = w.status === "running";
  const live = running && host?.running ? host : null;
  const cpu = running ? cpuCoresFromFreshSample(sample[0], now) : null;
  const diskLimit = host?.diskLimitBytes || limits?.diskBytes || 0;
  const up = uptimeSec(w.status, host?.startedAt, w.awakeSince, now);
  const p = ports(w.slot);
  const uid = tenantUid(w.slot);
  const emptyText = running ? "no data" : "not running";
  const bytes = (v: number, m: number) => `${formatBytes(v)} / ${formatBytes(m)}`;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Section
        title="Live usage"
        description={
          stats[0]
            ? `Metering tick ${formatAgo(stats[0].updatedAt, now)}. Meters fill against the plan limits.`
            : "No metering tick has been recorded yet."
        }
      >
        <div className="grid gap-4">
          <Meter
            label="CPU"
            value={live ? cpu : null}
            max={limits?.cpus ?? 1}
            emptyText={emptyText}
            format={(v, m) => `${v.toFixed(2)} / ${+m.toFixed(2)} cores`}
          />
          <Meter
            label="Memory"
            value={live ? live.memBytes : null}
            max={limits?.memBytes ?? 1}
            emptyText={emptyText}
            format={bytes}
          />
          <Meter
            label="Disk"
            value={host?.diskUsedBytes ?? null}
            max={diskLimit}
            emptyText="no data"
            format={bytes}
          />
          <Meter
            label="Inodes"
            value={host?.inodesUsed ?? null}
            max={host?.inodesLimit ?? 0}
            emptyText="no quota data"
            format={(v, m) => `${v.toLocaleString("en-US")} / ${m.toLocaleString("en-US")}`}
          />
          <Meter
            label="Processes"
            value={live?.pids ?? null}
            max={plan?.pidsLimit ?? 1}
            emptyText={emptyText}
            format={(v, m) => `${v} / ${m}`}
          />
          {live ? (
            <p className="text-meta text-muted-foreground">
              Since the last tick the workspace moved {formatBytes(live.gatewayBytesDelta ?? 0)}{" "}
              through the gateway and {formatBytes(live.egressBytesDelta ?? 0)} out to the internet.
              {live.oomKills ? ` ${live.oomKills} out-of-memory kills so far.` : ""}
            </p>
          ) : null}
          {!index ? (
            <Notice>
              Host readings are missing or older than five minutes. Check the agent on the System
              page.
            </Notice>
          ) : null}
        </div>
      </Section>

      <Section title="Technical facts">
        <KeyValueList
          items={[
            { label: "Uptime", value: up === null ? "Not running" : formatDuration(up) },
            { label: "Last activity", value: formatAgo(w.lastActivityAt, now) },
            { label: "Last request", value: formatAgo(w.lastRequestAt, now) },
            { label: "Slot", value: w.slot, mono: true },
            { label: "Linux user", value: linuxUser(w.slug), mono: true },
            { label: "UID", value: uid, mono: true },
            { label: "T3 Code port", value: p.t3, mono: true },
            { label: "VS Code port", value: p.code, mono: true },
            { label: "T3 Code host", value: `${w.slug}-t3.${domain}`, mono: true },
            { label: "VS Code host", value: `${w.slug}-code.${domain}`, mono: true },
            { label: "Image", value: w.imageId ?? "none", mono: true },
            {
              label: "Cgroup parent",
              value: `user.slice/user-${uid}.slice`,
              mono: true,
            },
            {
              label: "Disk quota",
              value:
                host?.diskUsedBytes != null
                  ? `${formatBytes(host.diskUsedBytes)} used of ${diskLimit ? formatBytes(diskLimit) : "no limit"}`
                  : "No quota data",
            },
            {
              label: "Inodes",
              value:
                host?.inodesUsed != null
                  ? `${host.inodesUsed.toLocaleString("en-US")} used of ${host.inodesLimit ? host.inodesLimit.toLocaleString("en-US") : "no limit"}`
                  : "No quota data",
            },
            {
              label: "Start failures",
              value:
                w.startFailures > 0 ? (
                  <span className="text-destructive">{w.startFailures} in a row</span>
                ) : (
                  "None"
                ),
            },
            { label: "GitHub sync", value: w.githubSyncPending ? "Pending" : "Up to date" },
            { label: "Created", value: formatDateTime(w.createdAt) },
          ]}
        />
      </Section>
    </div>
  );
}

async function UsageTab({
  workspaceId,
  plan,
  rangeParam,
  slug,
  now,
}: {
  workspaceId: string;
  plan: PlanRow;
  rangeParam: string | undefined;
  slug: string;
  now: Date;
}) {
  const range = parseUsageRange(rangeParam);
  const data = await loadUsageSeries(db, workspaceId, range, now);
  const hasData = data.some((p) => p.cpuCores !== null || p.charge > 0);
  return (
    <Section
      title="Usage"
      description="From the per-minute metering samples. Gaps mean the workspace was asleep."
      actions={
        <div className="flex gap-1.5" role="group" aria-label="Time range">
          {(Object.keys(USAGE_RANGES) as (keyof typeof USAGE_RANGES)[]).map((r) => (
            <Button key={r} asChild size="sm" variant={r === range ? "secondary" : "outline"}>
              <Link
                href={`/admin/workspaces/${slug}?tab=usage&range=${r}`}
                aria-current={r === range ? "true" : undefined}
              >
                {USAGE_RANGES[r].label}
              </Link>
            </Button>
          ))}
        </div>
      }
    >
      {hasData ? (
        <UsageCharts
          data={data}
          range={range}
          cpuLimit={plan ? Number(plan.cpuLimit) : null}
          memLimitGb={plan ? plan.memoryLimitMb / 1024 : null}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          No usage in the last {USAGE_RANGES[range].label}. Samples appear while the workspace runs.
        </p>
      )}
    </Section>
  );
}

async function DiagnosticsTab({
  slug,
  workspaceId,
  kind,
  running,
  now,
}: {
  slug: string;
  workspaceId: string;
  kind: "processes" | "logs";
  running: boolean;
  now: Date;
}) {
  const { latest, lastDone } = await latestDiagnostics(
    db,
    workspaceId,
    kind === "logs" ? "fetch_logs" : "inspect_workspace",
  );
  return (
    <Section
      title={kind === "logs" ? "Logs" : "Processes"}
      description={
        kind === "logs"
          ? "Container output from the workspace, read on demand by the worker."
          : "What is running inside the workspace right now, read on demand by the worker."
      }
    >
      <DiagnosticPanel
        slug={slug}
        kind={kind}
        running={running}
        initialLatest={latest}
        initialDone={lastDone}
        now={now.toISOString()}
      />
    </Section>
  );
}

async function EventsTab({ workspaceId }: { workspaceId: string }) {
  const events = await db
    .select()
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspaceId))
    .orderBy(desc(workspaceEvents.createdAt))
    .limit(100);
  return (
    <Section title="Events" description="Newest first. Showing up to 100.">
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events yet. Starts, stops and crashes are recorded here.
        </p>
      ) : (
        <Timeline
          items={events.map((e) => ({
            id: e.id,
            title: e.type === "oom" ? "Out of memory" : statusLabel(e.type),
            time: formatDateTime(e.createdAt),
            status: EVENT_LIGHT[e.type] ?? "idle",
            detail: e.details ? <Mono>{JSON.stringify(e.details)}</Mono> : undefined,
          }))}
        />
      )}
    </Section>
  );
}

async function JobsTab({ workspaceId }: { workspaceId: string }) {
  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.workspaceId, workspaceId))
    .orderBy(desc(jobs.createdAt))
    .limit(50);
  // Results can be large (logs); the table never shows them.
  const views: JobView[] = rows.map((r) => ({ ...toJobView(r), result: null }));
  return (
    <Section
      title="Jobs"
      description="Latest 50 jobs for this workspace. Took is the time from queued to finished."
      bodyClassName={cn("p-0")}
    >
      <JobsTable jobs={views} />
    </Section>
  );
}
