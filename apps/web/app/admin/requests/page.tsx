import type { Metadata } from "next";
import { desc, eq, ne } from "drizzle-orm";
import { db, readSetting } from "@agentbox/db/client";
import { accessRequests, plans, user } from "@agentbox/db/schema";
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
import { formatDateTime } from "@/lib/format";
import { slugFromEmail } from "@/lib/slug";
import { RequestsTable, type PlanOption, type PendingRow } from "./requests-table";

export const metadata: Metadata = { title: "Access requests" };

export default async function RequestsPage() {
  const [pending, decided, planRows, billing] = await Promise.all([
    db
      .select({ r: accessRequests, u: user })
      .from(accessRequests)
      .innerJoin(user, eq(user.id, accessRequests.userId))
      .where(eq(accessRequests.status, "pending"))
      .orderBy(accessRequests.createdAt),
    db
      .select({ r: accessRequests, u: user })
      .from(accessRequests)
      .innerJoin(user, eq(user.id, accessRequests.userId))
      .where(ne(accessRequests.status, "pending"))
      .orderBy(desc(accessRequests.decidedAt))
      .limit(20),
    db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.name),
    readSetting(db, "billing"),
  ]);
  const rows: PendingRow[] = pending.map(({ r, u }) => ({
    id: r.id,
    userName: u.name,
    email: u.email,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
    suggestedSlug: slugFromEmail(u.email),
  }));
  const options: PlanOption[] = planRows.map((p) => ({ id: p.id, name: p.name }));
  const defaultPlanId =
    billing && options.some((p) => p.id === billing.defaultPlanId)
      ? billing.defaultPlanId
      : (options[0]?.id ?? "");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Pending requests</CardTitle>
          <CardDescription>
            Approving creates the user&apos;s workspace and subscription.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RequestsTable rows={rows} plans={options} defaultPlanId={defaultPlanId} />
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
                <TableHead>Status</TableHead>
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
