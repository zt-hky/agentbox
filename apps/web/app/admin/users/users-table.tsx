"use client";

import Link from "next/link";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  accessStatus: string;
  workspace: string | null;
  plan: string | null;
  createdAt: string;
}

const h = columnHelper<UserRow>();
const columns = [
  h.accessor("name", {
    header: "User",
    cell: (c) => (
      <Link href={`/admin/users/${c.row.original.id}`} className="block hover:underline">
        <div className="font-medium">{c.getValue()}</div>
        <div className="text-xs text-muted-foreground">{c.row.original.email}</div>
      </Link>
    ),
  }),
  h.accessor("role", {
    header: "Role",
    cell: (c) => <Badge variant="outline">{c.getValue()}</Badge>,
  }),
  h.accessor("accessStatus", {
    header: "Access",
    cell: (c) => <StatusBadge status={c.getValue()} />,
  }),
  h.accessor("workspace", { header: "Workspace", cell: (c) => c.getValue() ?? "" }),
  h.accessor("plan", { header: "Plan", cell: (c) => c.getValue() ?? "" }),
  h.accessor("createdAt", { header: "Joined", cell: (c) => c.getValue().slice(0, 10) }),
] as Columns<UserRow>;

export function UsersTable({ rows }: { rows: UserRow[] }) {
  return <DataTable columns={columns} data={rows} empty="No users." />;
}
