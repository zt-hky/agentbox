import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { workspaceSessions } from "@agentbox/db/schema";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { requireActiveUser } from "@/lib/session";
import { RevokeAllButton, SessionsTable, type SessionRow } from "./sessions-table";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage() {
  const { user } = await requireActiveUser();
  const rows = await db
    .select()
    .from(workspaceSessions)
    .where(eq(workspaceSessions.userId, user.id))
    .orderBy(desc(workspaceSessions.createdAt))
    .limit(100);
  const now = Date.now();
  const data: SessionRow[] = rows.map((r) => ({
    id: r.id,
    host: r.host,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    state: r.revokedAt ? "revoked" : r.expiresAt.getTime() <= now ? "expired" : "active",
  }));
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Browsers signed in to your workspace. Revoking one takes effect within about 30 seconds."
        actions={<RevokeAllButton anyActive={data.some((r) => r.state === "active")} />}
      />
      <Section title="Workspace sessions" bodyClassName="p-0">
        <SessionsTable rows={data} />
      </Section>
    </>
  );
}
