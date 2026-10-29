import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger, user, workspaces } from "@agentbox/db/schema";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { baseDomain } from "@/lib/env";
import { formatCredits } from "@/lib/money";
import { creditLabel, planOptions } from "@/lib/queries";
import { requireAdmin } from "@/lib/session";
import { slugFromEmail } from "@/lib/slug";
import { loadBalance, loadSubscription } from "@/lib/user-data";
import {
  AccessControl,
  ApproveUserButton,
  CreditsForm,
  PlanControl,
  RoleControl,
} from "./user-controls";

export const metadata: Metadata = { title: "User" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const { id } = await params;
  const target = (await db.select().from(user).where(eq(user.id, id)).limit(1))[0];
  if (!target) notFound();

  const [sub, balance, label, ws, ledger, plans] = await Promise.all([
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
    planOptions(),
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
        <CardContent className="space-y-4">
          {workspace ? null : (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {target.accessStatus === "active"
                ? "This account has access but no workspace yet. Create one to assign a plan."
                : "This user has not been approved yet. Approving gives access, assigns a plan and provisions a workspace in one step."}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-6">
            <RoleControl userId={target.id} role={target.role ?? "user"} isSelf={isSelf} />
            {workspace ? (
              <>
                <PlanControl
                  userId={target.id}
                  planId={sub?.plan.id ?? null}
                  plans={plans.options}
                />
                <AccessControl
                  userId={target.id}
                  accessStatus={target.accessStatus}
                  isSelf={isSelf}
                />
              </>
            ) : (
              <>
                <ApproveUserButton
                  label={target.accessStatus === "active" ? "Create workspace" : "Approve access"}
                  target={{
                    userId: target.id,
                    email: target.email,
                    suggestedSlug: slugFromEmail(target.email),
                  }}
                  plans={plans.options}
                  defaultPlanId={plans.defaultPlanId}
                  baseDomain={baseDomain()}
                />
                {target.accessStatus !== "suspended" && !isSelf ? (
                  <AccessControl
                    userId={target.id}
                    accessStatus={target.accessStatus}
                    isSelf={isSelf}
                  />
                ) : null}
              </>
            )}
          </div>
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
