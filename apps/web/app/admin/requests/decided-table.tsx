"use client";

import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";

export interface DecidedRow {
  id: string;
  email: string;
  status: string;
  reason: string | null;
  decidedAt: string | null;
}

const h = columnHelper<DecidedRow>();
const columns = [
  h.accessor("email", { header: "User" }),
  h.accessor("status", { header: "Decision", cell: (c) => <StatusBadge status={c.getValue()} /> }),
  h.accessor("reason", {
    header: "Reason",
    cell: (c) => (
      <span className="line-clamp-2 max-w-sm whitespace-normal text-muted-foreground">
        {c.getValue() ?? "No reason given"}
      </span>
    ),
  }),
  h.accessor("decidedAt", {
    header: "Decided",
    cell: (c) => (c.getValue() ? `${c.getValue()!.slice(0, 16).replace("T", " ")} UTC` : "never"),
  }),
] as Columns<DecidedRow>;

export function DecidedTable({ rows }: { rows: DecidedRow[] }) {
  return <DataTable flush columns={columns} data={rows} empty="No decisions yet." />;
}
