"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { revokeAllSessions, revokeSession } from "./actions";

export interface SessionRow {
  id: string;
  host: string;
  createdAt: string;
  expiresAt: string;
  state: "active" | "revoked" | "expired";
}

function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await revokeSession(id);
          if (!res.ok) toast.error(res.error);
          else router.refresh();
        })
      }
    >
      Revoke
    </Button>
  );
}

const h = columnHelper<SessionRow>();
const columns = [
  h.accessor("host", { header: "Host", cell: (c) => <Mono>{c.getValue()}</Mono> }),
  h.accessor("createdAt", {
    header: "Signed in",
    cell: (c) => c.getValue().slice(0, 16).replace("T", " "),
  }),
  h.accessor("expiresAt", {
    header: "Expires",
    cell: (c) => c.getValue().slice(0, 16).replace("T", " "),
  }),
  h.accessor("state", {
    header: "State",
    cell: (c) => <StatusBadge status={c.getValue()} />,
  }),
  h.display({
    id: "actions",
    header: "",
    cell: (c) =>
      c.row.original.state === "active" ? <RevokeButton id={c.row.original.id} /> : null,
  }),
] as Columns<SessionRow>;

/** Header action: revoke every active session after confirming. */
export function RevokeAllButton({ anyActive }: { anyActive: boolean }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" disabled={!anyActive}>
          Revoke all
        </Button>
      }
      title="Revoke all sessions?"
      description="Every browser signed in to your workspace will be signed out within about 30 seconds. You can sign in again from the dashboard."
      confirmLabel="Revoke all"
      destructive
      onConfirm={async () => {
        const res = await revokeAllSessions();
        if (res.ok) {
          toast.success("All sessions revoked");
          router.refresh();
        }
        return res;
      }}
    />
  );
}

export function SessionsTable({ rows }: { rows: SessionRow[] }) {
  return (
    <DataTable
      flush
      columns={columns}
      data={rows}
      empty="No workspace sessions yet. One appears when you open K-code or VS Code."
    />
  );
}
