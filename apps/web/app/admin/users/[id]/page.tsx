import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { creditLedger, user, workspaces } from "@agentbox/db/schema";
import { LedgerTable, type LedgerRow } from "@/components/ledger-table";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { WorkspaceModule } from "@/components/workspace-module";
import { loadRack } from "@/lib/admin/workspaces-ops";
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
  const now = new Date();
  const rack = ws[0] ? (await loadRack(db, now, { userId: id }))[0] : undefined;
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
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {target.name}
            <Badge variant="outline">{target.role ?? "user"}</Badge>
            <StatusBadge status={target.accessStatus} />
          </span>
        }
        description={target.email}
      />

      {rack ? (
        <WorkspaceModule
          variant="row"
          href={`/admin/workspaces/${rack.slug}`}
          now={now}
          ws={{
            slug: rack.slug,
            status: rack.status,
            owner: rack.ownerEmail,
            plan: rack.planName,
            lastActivityAt: rack.lastActivityAt ? new Date(rack.lastActivityAt) : null,
            awakeSince: rack.awakeSince ? new Date(rack.awakeSince) : null,
          }}
          live={{ cpuCores: rack.cpuCores, memBytes: rack.memBytes, diskBytes: rack.diskBytes }}
          limits={rack.limits}
        />
      ) : (
        <EmptyState
          title="No workspace yet"
          description={
            target.accessStatus === "active"
              ? "This account has access but no workspace. Create one to assign a plan."
              : "This user has not been approved. Approving gives access, assigns a plan and provisions a workspace in one step."
          }
        />
      )}

      <Section title="Account" description="Role, plan and access.">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-5">
          <RoleControl userId={target.id} role={target.role ?? "user"} isSelf={isSelf} />
          {workspace ? (
            <>
              <PlanControl userId={target.id} planId={sub?.plan.id ?? null} plans={plans.options} />
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
      </Section>

      <Section
        title={`Credits: ${formatCredits(balance, label)}`}
        description="Adding records an admin top-up; removing records a negative adjustment. A note is required."
      >
        <CreditsForm userId={target.id} label={label} />
      </Section>

      <Section title="Ledger" description="Latest 200 entries." bodyClassName="p-0">
        <LedgerTable rows={rows} />
      </Section>
    </>
  );
}
