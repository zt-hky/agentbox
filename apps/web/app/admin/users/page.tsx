import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { plans, subscriptions, user, workspaces } from "@agentbox/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsersTable, type UserRow } from "./users-table";

export const metadata: Metadata = { title: "Users" };

export default async function AdminUsersPage() {
  const rows = await db
    .select({ u: user, slug: workspaces.slug, plan: plans.name })
    .from(user)
    .leftJoin(workspaces, eq(workspaces.userId, user.id))
    .leftJoin(subscriptions, eq(subscriptions.userId, user.id))
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .orderBy(desc(user.createdAt))
    .limit(500);
  const data: UserRow[] = rows.map(({ u, slug, plan }) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role ?? "user",
    accessStatus: u.accessStatus,
    workspace: slug,
    plan,
    createdAt: u.createdAt.toISOString(),
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
      </CardHeader>
      <CardContent>
        <UsersTable rows={data} />
      </CardContent>
    </Card>
  );
}
