"use client";

import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { jobDurationSec, type JobView } from "@/lib/admin/workspaces";
import { formatDuration } from "@/lib/format";

const h = columnHelper<JobView>();
const columns = [
  h.accessor("type", {
    header: "Job",
    cell: (c) => <span className="font-mono text-[0.92em]">{c.getValue()}</span>,
  }),
  h.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} /> }),
  h.accessor("attempts", { header: "Attempts" }),
  h.display({
    id: "took",
    header: "Took",
    cell: (c) => {
      const s = jobDurationSec(c.row.original);
      return s === null ? (
        <span className="text-muted-foreground">not finished</span>
      ) : (
        formatDuration(s)
      );
    },
  }),
  h.accessor("createdAt", {
    header: "Queued",
    cell: (c) => `${c.getValue().slice(0, 16).replace("T", " ")} UTC`,
  }),
  h.accessor("lastError", {
    header: "Last error",
    cell: (c) =>
      c.getValue() ? (
        <span className="line-clamp-2 max-w-md whitespace-normal text-destructive">
          {c.getValue()}
        </span>
      ) : (
        <span className="text-muted-foreground">none</span>
      ),
  }),
] as Columns<JobView>;

export function JobsTable({ jobs }: { jobs: JobView[] }) {
  return (
    <DataTable
      flush
      columns={columns}
      data={jobs}
      empty="No jobs yet. Starting, stopping and diagnostics appear here."
    />
  );
}
