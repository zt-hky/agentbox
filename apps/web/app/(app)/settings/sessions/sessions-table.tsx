"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
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
  h.accessor("host", { header: "Host" }),
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
    cell: (c) => (
      <Badge variant={c.getValue() === "active" ? "default" : "outline"}>{c.getValue()}</Badge>
    ),
  }),
  h.display({
    id: "actions",
    header: "",
    cell: (c) =>
      c.row.original.state === "active" ? <RevokeButton id={c.row.original.id} /> : null,
  }),
] as Columns<SessionRow>;

export function SessionsTable({ rows }: { rows: SessionRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const anyActive = rows.some((r) => r.state === "active");
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="destructive"
          disabled={pending || !anyActive}
          onClick={() =>
            start(async () => {
              const res = await revokeAllSessions();
              if (!res.ok) toast.error(res.error);
              else {
                toast.success("All sessions revoked");
                router.refresh();
              }
            })
          }
        >
          Revoke all
        </Button>
      </div>
      <DataTable columns={columns} data={rows} empty="No workspace sessions." />
    </div>
  );
}
