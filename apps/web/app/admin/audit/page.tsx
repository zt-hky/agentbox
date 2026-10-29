import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { auditLog, user } from "@agentbox/db/schema";
import { EmptyState } from "@/components/empty-state";
import { Mono } from "@/components/mono";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
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
export const dynamic = "force-dynamic";

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
  const head = "h-9 text-meta font-medium text-muted-foreground";
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every administrative action: who did it, to what, and from where. Newest first."
      />
      <Section title="Actions" bodyClassName="p-0">
        {visible.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No audit entries yet"
              description="Entries appear when an admin approves a user, changes a setting or manages a job."
            />
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-rack">
              <TableRow>
                <TableHead className={`${head} pl-5`}>Time</TableHead>
                <TableHead className={head}>Actor</TableHead>
                <TableHead className={head}>Action</TableHead>
                <TableHead className={head}>Target</TableHead>
                <TableHead className={head}>Details</TableHead>
                <TableHead className={`${head} pr-5`}>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ a, email }) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-5 text-meta whitespace-nowrap">
                    {formatDateTime(a.createdAt)}
                  </TableCell>
                  <TableCell>{email ?? a.actorId ?? "System"}</TableCell>
                  <TableCell>
                    <Mono>{a.action}</Mono>
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate text-meta"
                    title={a.targetId ?? undefined}
                  >
                    {a.targetType ? (
                      <>
                        {a.targetType} <Mono className="text-xs">{a.targetId ?? ""}</Mono>
                      </>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className="max-w-xs truncate font-mono text-xs text-muted-foreground"
                    title={a.metadata ? JSON.stringify(a.metadata) : undefined}
                  >
                    {a.metadata ? JSON.stringify(a.metadata) : ""}
                  </TableCell>
                  <TableCell className="pr-5 text-meta">
                    <Mono className="text-xs">{a.ip ?? ""}</Mono>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {page > 0 || hasNext ? (
          <div className="flex justify-end gap-2 border-t px-5 py-3">
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
        ) : null}
      </Section>
    </>
  );
}
