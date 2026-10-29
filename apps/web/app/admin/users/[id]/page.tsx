import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger, plans, user, workspaces } from "@agentbox/db/schema";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCredits } from "@/lib/money";
import { creditLabel } from "@/lib/queries";
import { requireAdmin } from "@/lib/session";
import { loadBalance, loadSubscription } from "@/lib/user-data";
import { AccessControl, CreditsForm, PlanControl, RoleControl } from "./user-controls";

export const metadata: Metadata = { title: "User" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const { id } = await params;
  const target = (await db.select().from(user).where(eq(user.id, id)).limit(1))[0];
  if (!target) notFound();

  const [sub, balance, label, ws, ledger, planRows] = await Promise.all([
    loadSubscription(id),
    loadBalance(id),
    creditLabel(),
    db.select().from(workspaces).where(eq(workspaces.userId, id)).limit(1),
    db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, id))
      .orderBy(desc(creditLedger.createdAt))
      .limit(200),
    db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.name),
  ]);
  const rows: LedgerRow[] = ledger.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    reason: l.reason,
    deltaMicro: l.deltaMicro.toString(),
    note: l.note,
  }));
  const workspace = ws[0];
  const isSelf = target.id === session.user.id;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {target.name}
            <Badge variant="outline">{target.role ?? "user"}</Badge>
            <StatusBadge status={target.accessStatus} />
          </CardTitle>
          <CardDescription>
            {target.email}
            {workspace ? (
              <>
                {" · workspace "}
                <Link className="underline" href={`/admin/workspaces/${workspace.slug}`}>
                  {workspace.slug}
                </Link>{" "}
                (<StatusBadge status={workspace.status} />)
              </>
            ) : (
              " · no workspace"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-6">
          <RoleControl userId={target.id} role={target.role ?? "user"} isSelf={isSelf} />
          <PlanControl
            userId={target.id}
            planId={sub?.plan.id ?? null}
            plans={planRows.map((p) => ({ id: p.id, name: p.name }))}
          />
          <AccessControl userId={target.id} accessStatus={target.accessStatus} isSelf={isSelf} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credits: {formatCredits(balance, label)}</CardTitle>
          <CardDescription>
            Adding records an admin top-up; removing records a negative adjustment. A note is
            required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreditsForm userId={target.id} label={label} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>Latest 200 entries</CardDescription>
        </CardHeader>
        <CardContent>
          <LedgerTable rows={rows} />
        </CardContent>
      </Card>
    </>
  );
}
