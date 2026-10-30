import type { Metadata } from "next";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { accessRequests, user, workspaces } from "@agentbox/db/schema";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { baseDomain } from "@/lib/env";
import { planOptions } from "@/lib/queries";
import { slugFromEmail } from "@/lib/slug";
import { DecidedTable, type DecidedRow } from "./decided-table";
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
      suggestedSlug: r?.requestedSlug ?? slugFromEmail(u.email),
    }))
    .sort((a, b) => (STATUS_ORDER[a.accessStatus] ?? 9) - (STATUS_ORDER[b.accessStatus] ?? 9));
  const pendingCount = rows.filter((r) => r.accessStatus === "pending").length;

  const decidedRows: DecidedRow[] = decided.map(({ r, u }) => ({
    id: r.id,
    email: u.email,
    status: r.status,
    reason: r.reason,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  }));

  return (
    <>
      <PageHeader
        title="Access requests"
        description="Approving gives access and assigns a plan. The user creates the workspace during setup."
      />
      <Section
        title="Waiting for approval"
        description={`${pendingCount} pending. Everyone who has signed in but has no workspace yet is listed, pending requests first.`}
        bodyClassName="p-0"
      >
        <RequestsTable
          rows={rows}
          plans={plans.options}
          defaultPlanId={plans.defaultPlanId}
          baseDomain={baseDomain()}
        />
      </Section>
      <Section title="Recently decided" description="The last 20 decisions." bodyClassName="p-0">
        <DecidedTable rows={decidedRows} />
      </Section>
    </>
  );
}
