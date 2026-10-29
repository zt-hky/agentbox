import type { Metadata } from "next";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { accessRequests, user, workspaces } from "@agentbox/db/schema";
import { StatusBadge } from "@/components/status-badge";
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
import { formatDateTime } from "@/lib/format";
import { planOptions } from "@/lib/queries";
import { slugFromEmail } from "@/lib/slug";
import { RequestsTable, type AwaitingRow } from "./requests-table";

export const metadata: Metadata = { title: "Access requests" };

const STATUS_ORDER: Record<string, number> = { pending: 0, none: 1, rejected: 2, suspended: 3 };

export default async function RequestsPage() {
  const [awaiting, decided, plans] = await Promise.all([
    // Everyone signed in without a workspace: pending requests first, then users who never
    // requested, were rejected, or were suspended before being approved.
    db
      .select({ u: user, r: accessRequests })
      .from(user)
      .leftJoin(workspaces, eq(workspaces.userId, user.id))
      .leftJoin(
        accessRequests,
        and(eq(accessRequests.userId, user.id), eq(accessRequests.status, "pending")),
      )
      .where(and(ne(user.accessStatus, "active"), isNull(workspaces.id)))
      .orderBy(user.createdAt),
    db
      .select({ r: accessRequests, u: user })
      .from(accessRequests)
      .innerJoin(user, eq(user.id, accessRequests.userId))
      .where(ne(accessRequests.status, "pending"))
      .orderBy(desc(accessRequests.decidedAt))
      .limit(20),
    planOptions(),
  ]);
  const rows: AwaitingRow[] = awaiting
    .map(({ u, r }) => ({
      userId: u.id,
      userName: u.name,
      email: u.email,
      accessStatus: u.accessStatus,
      requestId: r?.id ?? null,
      message: r?.message ?? null,
      since: (r?.createdAt ?? u.createdAt).toISOString(),
      suggestedSlug: slugFromEmail(u.email),
    }))
    .sort((a, b) => (STATUS_ORDER[a.accessStatus] ?? 9) - (STATUS_ORDER[b.accessStatus] ?? 9));
  const pendingCount = rows.filter((r) => r.accessStatus === "pending").length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Waiting for approval ({pendingCount} pending)</CardTitle>
          <CardDescription>
            Everyone who has signed in but has no workspace yet. Approving gives access, assigns a
            plan and provisions the workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RequestsTable
            rows={rows}
            plans={plans.options}
            defaultPlanId={plans.defaultPlanId}
            baseDomain={baseDomain()}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recently decided</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Decided</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {decided.map(({ r, u }) => (
                <TableRow key={r.id}>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="max-w-sm whitespace-normal">{r.reason ?? ""}</TableCell>
                  <TableCell>{formatDateTime(r.decidedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
