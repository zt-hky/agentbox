import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { jobs } from "@agentbox/db/schema";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  JOB_STATUSES,
  JOB_TYPES,
  listJobs,
  parseJobFilters,
  type JobFilters,
} from "@/lib/admin/system-jobs";
import { formatJobDuration, previewJson } from "@/lib/admin/system";
import { formatDateTime } from "@/lib/format";
import { statusLabel } from "@/components/status-light";
import { JobsTable, type JobRowData } from "./jobs-table";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

const MAX_TEXT = 20_000;

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... truncated` : text;
}

function href(f: JobFilters, patch: Partial<JobFilters>): string {
  const next = { ...f, ...patch };
  const q = new URLSearchParams();
  if (next.status) q.set("status", next.status);
  if (next.type) q.set("type", next.type);
  if (next.ws) q.set("ws", next.ws);
  if (next.page > 0) q.set("page", String(next.page));
  const s = q.toString();
  return s ? `/admin/jobs?${s}` : "/admin/jobs";
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseJobFilters(await searchParams);
  const now = new Date();
  const [{ rows, hasNext }, counts] = await Promise.all([
    listJobs(db, filters),
    db
      .select({ status: jobs.status, n: sql<number>`count(*)::int` })
      .from(jobs)
      .groupBy(jobs.status),
  ]);
  const countOf = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const data: JobRowData[] = rows.map(({ job, slug }) => ({
    id: job.id,
    type: job.type,
    status: job.status,
    slug,
    attempts: job.attempts,
    lastError: job.lastError,
    payloadText: pretty(job.payload),
    resultPreview: previewJson(job.result, 120),
    resultText: pretty(job.result),
    createdAt: formatDateTime(job.createdAt),
    finishedAt: job.finishedAt ? formatDateTime(job.finishedAt) : "not finished",
    duration: formatJobDuration(job, now),
  }));
  const filtered = Boolean(filters.status || filters.type || filters.ws);

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Everything the worker has been asked to do. Retry a failed job to run it again, or cancel one that has not started."
      />
      <div className="flex flex-wrap gap-2">
        {JOB_STATUSES.map((s) => (
          <Button key={s} asChild size="sm" variant={filters.status === s ? "default" : "outline"}>
            <Link href={href(filters, { status: filters.status === s ? undefined : s, page: 0 })}>
              {statusLabel(s)} <span className="tabular-nums">{countOf(s)}</span>
            </Link>
          </Button>
        ))}
      </div>
      <Section title="All jobs" bodyClassName="p-0">
        <form
          action="/admin/jobs"
          method="get"
          className="grid gap-3 border-b px-5 py-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
        >
          <label className="grid gap-1.5 text-meta text-muted-foreground">
            Status
            <select name="status" defaultValue={filters.status ?? ""} className={selectClass}>
              <option value="">Any status</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-meta text-muted-foreground">
            Type
            <select name="type" defaultValue={filters.type ?? ""} className={selectClass}>
              <option value="">Any type</option>
              {JOB_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-meta text-muted-foreground">
            Workspace
            <Input
              name="ws"
              defaultValue={filters.ws ?? ""}
              placeholder="Workspace name, e.g. maidev"
              className="font-mono"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            {filtered ? (
              <Button asChild variant="ghost">
                <Link href="/admin/jobs">Clear</Link>
              </Button>
            ) : null}
          </div>
        </form>
        {data.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={filtered ? "No jobs match these filters" : "No jobs yet"}
              description={
                filtered
                  ? "Clear a filter or check the workspace name."
                  : "Jobs appear here when someone starts, stops or provisions a workspace."
              }
            />
          </div>
        ) : (
          <JobsTable rows={data} />
        )}
        {filters.page > 0 || hasNext ? (
          <div className="flex justify-end gap-2 border-t px-5 py-3">
            {filters.page > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(filters, { page: filters.page - 1 })}>Newer</Link>
              </Button>
            ) : null}
            {hasNext ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(filters, { page: filters.page + 1 })}>Older</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </Section>
    </>
  );
}
