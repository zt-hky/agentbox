"use client";

import Link from "next/link";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
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

const none = <span className="text-muted-foreground">none</span>;

const h = columnHelper<UserRow>();
const columns = [
  h.accessor("name", {
    header: "User",
    cell: (c) => (
      <Link href={`/admin/users/${c.row.original.id}`} className="block hover:underline">
        <div className="font-medium">{c.getValue()}</div>
        <div className="text-meta text-muted-foreground">{c.row.original.email}</div>
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
  h.accessor("workspace", {
    header: "Workspace",
    cell: (c) =>
      c.getValue() ? (
        <Link href={`/admin/workspaces/${c.getValue()}`} className="hover:underline">
          <Mono>{c.getValue()}</Mono>
        </Link>
      ) : (
        none
      ),
  }),
  h.accessor("plan", { header: "Plan", cell: (c) => c.getValue() ?? none }),
  h.accessor("createdAt", { header: "Joined", cell: (c) => c.getValue().slice(0, 10) }),
] as Columns<UserRow>;

export function UsersTable({ rows }: { rows: UserRow[] }) {
  return (
    <DataTable
      flush
      columns={columns}
      data={rows}
      empty="No users yet. People appear here after they sign in."
    />
  );
}
