import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { user, workspaces } from "@agentbox/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspacesTable, type WorkspaceRow } from "./workspaces-table";

export const metadata: Metadata = { title: "Workspaces" };

export default async function AdminWorkspacesPage() {
  const rows = await db
    .select({ w: workspaces, email: user.email })
    .from(workspaces)
    .innerJoin(user, eq(user.id, workspaces.userId))
    .orderBy(desc(workspaces.createdAt));
  const data: WorkspaceRow[] = rows.map(({ w, email }) => ({
    slug: w.slug,
    email,
    status: w.status,
    slot: w.slot,
    imageId: w.imageId,
    lastActivityAt: w.lastActivityAt?.toISOString() ?? null,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
      </CardHeader>
      <CardContent>
        <WorkspacesTable rows={data} />
      </CardContent>
    </Card>
  );
}
