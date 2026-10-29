import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { workspaceSessions } from "@agentbox/db/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireActiveUser } from "@/lib/session";
import { SessionsTable, type SessionRow } from "./sessions-table";

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
    <Card>
      <CardHeader>
        <CardTitle>Workspace sessions</CardTitle>
        <CardDescription>
          Browser sessions signed in to your workspace. Revocation takes effect within about 30
          seconds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SessionsTable rows={data} />
      </CardContent>
    </Card>
  );
}
