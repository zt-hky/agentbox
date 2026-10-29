import type { Metadata } from "next";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { statsResponseSchema } from "@agentbox/core/agent-api";
import { db, readSetting } from "@agentbox/db/client";
import { hostStats, plans, subscriptions, workspaceEvents, workspaces } from "@agentbox/db/schema";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Admin overview" };

export default async function AdminOverviewPage() {
  const [statsRow, ratioSetting, counts, running, events] = await Promise.all([
    db.select().from(hostStats).where(eq(hostStats.id, 1)).limit(1),
    readSetting(db, "capacity"),
    db
      .select({ status: workspaces.status, n: sql<number>`count(*)::int` })
      .from(workspaces)
      .groupBy(workspaces.status),
    db
      .select({ memoryMb: plans.memoryLimitMb })
      .from(workspaces)
      .innerJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(inArray(workspaces.status, ["running", "starting"])),
    db
      .select({ e: workspaceEvents, slug: workspaces.slug })
      .from(workspaceEvents)
      .innerJoin(workspaces, eq(workspaces.id, workspaceEvents.workspaceId))
      .orderBy(desc(workspaceEvents.createdAt))
      .limit(15),
  ]);

  const parsed = statsResponseSchema.safeParse(statsRow[0]?.payload);
  const host = parsed.success ? parsed.data.host : null;
  const total = counts.filter((c) => c.status !== "deleted").reduce((a, c) => a + c.n, 0);
  const runningCount = counts.find((c) => c.status === "running")?.n ?? 0;
  const allocatedBytes = running.reduce((a, r) => a + r.memoryMb, 0) * 1024 * 1024;
  const ratio = ratioSetting?.maxRunningMemoryRatio ?? 0.8;
  const capacityBytes = host ? host.memTotalBytes * ratio : 0;
  const allocPct = capacityBytes > 0 ? Math.min(100, (allocatedBytes / capacityBytes) * 100) : 0;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Workspaces running</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {runningCount} / {total}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Host memory available</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {host
                ? `${formatBytes(host.memAvailableBytes)} / ${formatBytes(host.memTotalBytes)}`
                : "no data"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Tenant disk free</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {host
                ? `${formatBytes(host.diskFreeBytes)} / ${formatBytes(host.diskTotalBytes)}`
                : "no data"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Load average ({host?.cpus ?? "?"} CPUs)</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {host ? host.loadavg.map((l) => l.toFixed(2)).join(" ") : "no data"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Memory allocation</CardTitle>
          <CardDescription>
            Plan memory limits of running workspaces vs. capacity ({Math.round(ratio * 100)}% of
            host memory)
            {statsRow[0] ? ` · stats updated ${formatDateTime(statsRow[0].updatedAt)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Progress value={allocPct} />
          <p className="text-sm text-muted-foreground">
            {formatBytes(allocatedBytes)} allocated of{" "}
            {capacityBytes > 0 ? formatBytes(capacityBytes) : "unknown"}
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            {counts.map((c) => (
              <Badge key={c.status} variant="outline">
                {c.status}: {c.n}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No events yet.
                  </TableCell>
                </TableRow>
              ) : (
                events.map(({ e, slug }) => (
                  <TableRow key={e.id}>
                    <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                    <TableCell>{slug}</TableCell>
                    <TableCell>
                      <StatusBadge status={e.type} />
                    </TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs">
                      {e.details ? JSON.stringify(e.details) : ""}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
