import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { auditLog, user } from "@agentbox/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(0, Number.parseInt(pageParam ?? "0", 10) || 0);
  const rows = await db
    .select({ a: auditLog, email: user.email })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorId))
    .orderBy(desc(auditLog.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset(page * PAGE_SIZE);
  const hasNext = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                    No audit entries.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map(({ a, email }) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(a.createdAt)}
                    </TableCell>
                    <TableCell>{email ?? a.actorId ?? "system"}</TableCell>
                    <TableCell className="font-mono text-xs">{a.action}</TableCell>
                    <TableCell className="text-xs">
                      {a.targetType ? `${a.targetType}:${a.targetId ?? ""}` : ""}
                    </TableCell>
                    <TableCell
                      className="max-w-md truncate font-mono text-xs"
                      title={JSON.stringify(a.metadata)}
                    >
                      {a.metadata ? JSON.stringify(a.metadata) : ""}
                    </TableCell>
                    <TableCell className="text-xs">{a.ip ?? ""}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end gap-2">
          {page > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/audit?page=${page - 1}`}>Newer</Link>
            </Button>
          ) : null}
          {hasNext ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/audit?page=${page + 1}`}>Older</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
