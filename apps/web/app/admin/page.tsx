import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, readSetting } from "@agentbox/db/client";
import {
  hostStats,
  plans,
  subscriptions,
  usageSamples,
  workspaceEvents,
  workspaces,
} from "@agentbox/db/schema";
import { EmptyState } from "@/components/empty-state";
import { KeyValueList } from "@/components/key-value-list";
import { Meter } from "@/components/meter";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Stat } from "@/components/stat";
import { StatusLight } from "@/components/status-light";
import { Timeline } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import {
  ageSeconds,
  classifyQueue,
  computeCapacity,
  describeEvent,
  describeHeartbeat,
  describeServices,
  describeStatsAge,
  healthLight,
  parseHostPayload,
  topBy,
  type ServiceReport,
} from "@/lib/admin/system";
import { cpuCoresFromSample } from "@/lib/live-stats";
import { formatAgo, formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin overview" };
export const dynamic = "force-dynamic";

const SAMPLE_FRESH_MS = 10 * 60_000;
const num = (n: number) => n.toLocaleString("en-US");

function HealthRow({ r }: { r: ServiceReport }) {
  const light = healthLight(r.health);
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <StatusLight status={light.status} label={light.label} className="mt-1.5" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className="font-medium">{r.label}</span>
          <span className="text-meta text-muted-foreground">{r.detail}</span>
        </p>
        <p className="text-meta text-muted-foreground">{r.meaning}</p>
      </div>
    </li>
  );
}

function TopList({
  rows,
  format,
  max,
  empty,
}: {
  rows: { slug: string; value: number; limit: number }[];
  format: (v: number) => string;
  max: (limit: number) => number;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-3">
      {rows.map((r) => (
        <li
          key={r.slug}
          className="grid grid-cols-[minmax(0,8rem)_1fr] items-center gap-3 sm:grid-cols-[10rem_1fr]"
        >
          <Link
            href={`/admin/workspaces/${r.slug}`}
            className="truncate text-sm text-signal hover:underline"
          >
            <Mono>{r.slug}</Mono>
          </Link>
          <Meter
            compact
            label={`${r.slug} usage`}
            value={r.value}
            max={max(r.limit)}
            format={(v) => format(v)}
          />
        </li>
      ))}
    </ul>
  );
}

export default async function AdminOverviewPage() {
  const now = new Date();
  const [statsRow, capacitySetting, counts, active, events] = await Promise.all([
    db.select().from(hostStats).where(eq(hostStats.id, 1)).limit(1),
    readSetting(db, "capacity"),
    db
      .select({ status: workspaces.status, n: sql<number>`count(*)::int` })
      .from(workspaces)
      .groupBy(workspaces.status),
    db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        memoryMb: plans.memoryLimitMb,
        cpuLimit: plans.cpuLimit,
      })
      .from(workspaces)
      .innerJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(inArray(workspaces.status, ["running", "starting"])),
    db
      .select({ e: workspaceEvents, slug: workspaces.slug })
      .from(workspaceEvents)
      .innerJoin(workspaces, eq(workspaces.id, workspaceEvents.workspaceId))
      .orderBy(desc(workspaceEvents.createdAt))
      .limit(12),
  ]);

  const samples = active.length
    ? await db
        .selectDistinctOn([usageSamples.workspaceId], {
          workspaceId: usageSamples.workspaceId,
          cpuCoreSec: usageSamples.cpuCoreSec,
          runtimeSec: usageSamples.runtimeSec,
        })
        .from(usageSamples)
        .where(
          and(
            inArray(
              usageSamples.workspaceId,
              active.map((a) => a.id),
            ),
            gt(usageSamples.ts, new Date(now.getTime() - SAMPLE_FRESH_MS)),
          ),
        )
        .orderBy(usageSamples.workspaceId, desc(usageSamples.ts))
    : [];

  const statsUpdatedAt = statsRow[0]?.updatedAt ?? null;
  const { stats, worker } = parseHostPayload(statsRow[0]?.payload);
  const host = stats?.host ?? null;

  const statsAge = ageSeconds(statsUpdatedAt, now);
  const heartbeatAge = ageSeconds(worker?.heartbeatAt, now);
  const heartbeat = describeHeartbeat(heartbeatAge);
  const statsHealth = describeStatsAge(statsAge);
  const services = [...describeServices(host?.services ?? []), heartbeat, statsHealth];
  const queue = classifyQueue(worker?.queue ?? null, heartbeat.health);

  const total = counts.filter((c) => c.status !== "deleted").reduce((a, c) => a + c.n, 0);
  const countOf = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const ratio = capacitySetting?.maxRunningMemoryRatio ?? 0.8;
  const capacity = computeCapacity({
    allocatedMb: active.map((a) => a.memoryMb),
    memTotalBytes: host?.memTotalBytes ?? null,
    maxRunningMemoryRatio: ratio,
  });

  const cpuOf = new Map(samples.map((s) => [s.workspaceId, cpuCoresFromSample(s)]));
  const reading = new Map(stats?.workspaces.map((w) => [w.ws, w]) ?? []);
  const live = active.map((a) => ({
    slug: a.slug,
    cpu: cpuOf.get(a.id) ?? null,
    cpuLimit: Number(a.cpuLimit),
    mem: reading.get(a.slug)?.running ? (reading.get(a.slug)?.memoryCurrent ?? null) : null,
    memLimit: a.memoryMb * 1024 * 1024,
  }));
  const topCpu = topBy(live, (r) => r.cpu, 5).map((r) => ({
    slug: r.slug,
    value: r.value,
    limit: r.cpuLimit,
  }));
  const topMem = topBy(live, (r) => r.mem, 5).map((r) => ({
    slug: r.slug,
    value: r.value,
    limit: r.memLimit,
  }));

  const memUsed = host ? host.memTotalBytes - host.memAvailableBytes : null;
  const diskUsed = host ? host.diskTotalBytes - host.diskFreeBytes : null;
  const fw = host?.firewall;
  const queueLight = healthLight(queue.health);
  const capLight = healthLight(capacity.health);

  return (
    <>
      <PageHeader
        title="Overview"
        description="The host, its services and what is running on it."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/admin/workspaces">Workspaces</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/jobs">Jobs</Link>
            </Button>
          </>
        }
      />

      {!host ? (
        <Notice tone="error">
          {statsRow[0]
            ? "The stored host readings are in an older format, so host figures are hidden. Update and restart the agent and worker to refresh them."
            : "No host readings yet. They appear once the worker has talked to the agent."}
        </Notice>
      ) : null}

      <Section
        title="Host"
        description={
          statsUpdatedAt ? `Readings updated ${formatAgo(statsUpdatedAt, now)}` : undefined
        }
        actions={
          <p className="text-meta text-muted-foreground">
            <span className="tabular-nums">{countOf("running")}</span> of{" "}
            <span className="tabular-nums">{total}</span> workspaces running
          </p>
        }
      >
        <div className="grid gap-6 lg:gap-8">
          <div className="grid gap-5 md:grid-cols-3 md:gap-8">
            <Meter
              label="Load, 1 minute"
              value={host?.loadavg[0] ?? null}
              max={host?.cpus ?? 1}
              format={(v, m) => `${v.toFixed(2)} of ${m} cores`}
            />
            <Meter
              label="Memory in use"
              value={memUsed}
              max={host?.memTotalBytes ?? 1}
              format={(v, m) => `${formatBytes(v)} of ${formatBytes(m)}`}
            />
            <Meter
              label="Tenant disk used"
              value={diskUsed}
              max={host?.diskTotalBytes ?? 1}
              format={(v, m) => `${formatBytes(v)} of ${formatBytes(m)}`}
            />
          </div>
          <div className="grid gap-x-10 gap-y-2 border-t pt-5 sm:grid-cols-2 sm:gap-y-0">
            <KeyValueList
              items={[
                {
                  label: "Load average",
                  value: host ? host.loadavg.map((l) => l.toFixed(2)).join("  ") : "no data",
                },
                { label: "CPUs", value: host ? String(host.cpus) : "no data" },
                { label: "Uptime", value: host ? formatDuration(host.uptimeSec) : "no data" },
              ]}
            />
            <KeyValueList
              items={[
                { label: "Kernel", value: host?.kernel ?? "no data", mono: true },
                { label: "Podman", value: host?.podmanVersion ?? "not reported", mono: true },
                {
                  label: "Public IP",
                  value: host
                    ? host.publicIpBlocked
                      ? `Blocked from workspaces (${host.publicIpBlocked})`
                      : "Not blocked"
                    : "no data",
                },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section
        title="Capacity"
        description={`Waking a workspace is refused once the memory limits of running workspaces would pass ${Math.round(ratio * 100)}% of host memory.`}
        actions={
          <span className="flex items-center gap-2 text-meta text-muted-foreground">
            <StatusLight status={capLight.status} label={capLight.label} />
            {capLight.label}
          </span>
        }
      >
        <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
          <Meter
            label="Allocated plan memory"
            value={capacity.capacityBytes > 0 ? capacity.allocatedBytes : null}
            max={capacity.capacityBytes}
            format={(v, m) => `${formatBytes(v)} of ${formatBytes(m)}`}
            emptyText="host memory unknown"
          />
          <div className="flex gap-8">
            <Stat label="Running or starting" value={String(active.length)} />
            <Stat
              label="Room left"
              value={capacity.capacityBytes > 0 ? formatBytes(capacity.freeBytes) : "no data"}
            />
          </div>
        </div>
      </Section>

      <div className="grid gap-8 lg:grid-cols-3">
        <Section
          title="Service health"
          description="A light is green when the thing is running and reporting on time."
          className="lg:col-span-2"
        >
          <ul className="divide-y">
            {services.map((r) => (
              <HealthRow key={r.name} r={r} />
            ))}
          </ul>
        </Section>

        <div className="grid content-start gap-8">
          <Section
            title="Job queue"
            actions={
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/jobs">Open jobs</Link>
              </Button>
            }
          >
            <div className="grid gap-4">
              <div className="flex gap-6">
                <Stat label="Queued" value={worker ? num(worker.queue.queued) : "no data"} />
                <Stat label="Running" value={worker ? num(worker.queue.running) : "no data"} />
                <Stat
                  label="Failed, 24 h"
                  value={
                    worker && worker.queue.failed24h > 0 ? (
                      <Link
                        href="/admin/jobs?status=failed"
                        className="text-destructive hover:underline"
                      >
                        {num(worker.queue.failed24h)}
                      </Link>
                    ) : worker ? (
                      "0"
                    ) : (
                      "no data"
                    )
                  }
                />
              </div>
              <p className="flex gap-2 text-meta text-muted-foreground">
                <StatusLight
                  status={queueLight.status}
                  label={queueLight.label}
                  className="mt-1.5"
                />
                {queue.meaning}
              </p>
            </div>
          </Section>

          <Section
            title="Firewall"
            description="Packets the host firewall dropped since it was last loaded."
          >
            {fw ? (
              <div className="grid gap-4">
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  <Stat label="Blocked" value={num(fw.blockedPackets)} />
                  <Stat label="Mail (SMTP)" value={num(fw.smtpPackets)} />
                  <Stat label="IPv6" value={num(fw.ipv6Packets)} />
                </div>
                <p className="text-meta text-muted-foreground">
                  Blocked is traffic to addresses workspaces must not reach, SMTP is outgoing mail
                  on port 25, and IPv6 is all IPv6 traffic; all three are dropped.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No firewall counters yet.</p>
            )}
          </Section>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title="Busiest by CPU"
          description="Average cores in use over the last metering minute, against the plan limit."
        >
          <TopList
            rows={topCpu}
            max={(l) => l}
            format={(v) => `${v.toFixed(2)} cores`}
            empty="Nothing is using CPU right now."
          />
        </Section>
        <Section title="Busiest by memory" description="Current memory against the plan limit.">
          <TopList
            rows={topMem}
            max={(l) => l}
            format={(v) => formatBytes(v)}
            empty="No running workspace has a memory reading."
          />
        </Section>
      </div>

      <Section
        title="Recent events"
        description="Latest starts, stops and problems across all workspaces."
      >
        {events.length === 0 ? (
          <EmptyState
            title="No events yet"
            description="Events appear when a workspace starts, stops or hits a limit."
          />
        ) : (
          <Timeline
            items={events.map(({ e, slug }) => {
              const d = describeEvent(e.type);
              return {
                id: e.id,
                status: d.light,
                title: (
                  <>
                    {d.title} on{" "}
                    <Link
                      href={`/admin/workspaces/${slug}`}
                      className="text-signal hover:underline"
                    >
                      <Mono>{slug}</Mono>
                    </Link>
                  </>
                ),
                time: formatDateTime(e.createdAt),
                detail: e.details ? (
                  <Mono className={cn("text-xs")}>{JSON.stringify(e.details)}</Mono>
                ) : undefined,
              };
            })}
          />
        )}
      </Section>
    </>
  );
}
