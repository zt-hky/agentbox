import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { statsResponseSchema } from "@agentbox/core/agent-api";
import { workspaceUrl } from "@agentbox/core/hosts";
import { db } from "@agentbox/db/client";
import { hostStats, user, workspaceEvents, workspaces } from "@agentbox/db/schema";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { baseDomain } from "@/lib/env";
import { formatBytes, formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { WorkspaceControls } from "./workspace-controls";

export const metadata: Metadata = { title: "Workspace" };

export default async function AdminWorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireAdmin();
  const { slug } = await params;
  const row = (
    await db
      .select({ w: workspaces, u: user })
      .from(workspaces)
      .innerJoin(user, eq(user.id, workspaces.userId))
      .where(eq(workspaces.slug, slug))
      .limit(1)
  )[0];
  if (!row) notFound();
  const { w, u } = row;

  const [events, statsRow] = await Promise.all([
    db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, w.id))
      .orderBy(desc(workspaceEvents.createdAt))
      .limit(30),
    db.select().from(hostStats).where(eq(hostStats.id, 1)).limit(1),
  ]);
  const parsed = statsResponseSchema.safeParse(statsRow[0]?.payload);
  const live = parsed.success ? parsed.data.workspaces.find((s) => s.ws === w.slug) : undefined;
  const domain = baseDomain();
  const openable = w.status !== "deleted" && w.status !== "deleting";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {w.slug}
            <StatusBadge status={w.status} />
          </CardTitle>
          <CardDescription>
            <Link className="underline" href={`/admin/users/${u.id}`}>
              {u.email}
            </Link>
            {` · slot ${w.slot} · image ${w.imageId ? w.imageId.slice(0, 12) : "none"} · last activity ${formatDateTime(w.lastActivityAt)} · start failures ${w.startFailures}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <WorkspaceControls slug={w.slug} status={w.status} />
          {openable ? (
            <div className="flex gap-2">
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
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live stats</CardTitle>
          <CardDescription>
            From the latest metering tick
            {statsRow[0] ? ` (${formatDateTime(statsRow[0].updatedAt)})` : ""}
            {" · "}
            <a
              className="underline"
              href={workspaceUrl(w.slug, "t3", domain)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {w.slug}-t3.{domain}
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {live ? (
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Memory</dt>
                <dd className="tabular-nums">{formatBytes(live.memoryCurrent)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">PIDs</dt>
                <dd className="tabular-nums">{live.pidsCurrent}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">OOM kills</dt>
                <dd className="tabular-nums">{live.oomKills}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Traffic since last tick</dt>
                <dd className="tabular-nums">
                  {formatBytes(live.gatewayBytesDelta)} gateway /{" "}
                  {formatBytes(live.egressBytesDelta)} egress
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No live stats (workspace not running).</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No events.
                  </TableCell>
                </TableRow>
              ) : (
                events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{formatDateTime(e.createdAt)}</TableCell>
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
