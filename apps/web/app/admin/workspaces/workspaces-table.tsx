"use client";

import Link from "next/link";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";

export interface WorkspaceRow {
  slug: string;
  email: string;
  status: string;
  slot: number;
  imageId: string | null;
  lastActivityAt: string | null;
}

const h = columnHelper<WorkspaceRow>();
const columns = [
  h.accessor("slug", {
    header: "Workspace",
    cell: (c) => (
      <Link href={`/admin/workspaces/${c.getValue()}`} className="font-medium hover:underline">
        {c.getValue()}
      </Link>
    ),
  }),
  h.accessor("email", { header: "User" }),
  h.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} /> }),
  h.accessor("slot", { header: "Slot" }),
  h.accessor("imageId", {
    header: "Image",
    cell: (c) => (c.getValue() ? c.getValue()!.slice(0, 12) : ""),
  }),
  h.accessor("lastActivityAt", {
    header: "Last activity",
    cell: (c) => (c.getValue() ? c.getValue()!.slice(0, 16).replace("T", " ") : "never"),
  }),
] as Columns<WorkspaceRow>;

export function WorkspacesTable({ rows }: { rows: WorkspaceRow[] }) {
  return <DataTable columns={columns} data={rows} empty="No workspaces." />;
}
