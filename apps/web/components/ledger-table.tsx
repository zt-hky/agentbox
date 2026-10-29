"use client";

import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { microToCredits } from "@/lib/money";

export interface LedgerRow {
  id: string;
  createdAt: string;
  reason: string;
  deltaMicro: string;
  note: string | null;
}

const h = columnHelper<LedgerRow>();
const columns = [
  h.accessor("createdAt", {
    header: "Date",
    cell: (c) => c.getValue().slice(0, 16).replace("T", " "),
  }),
  h.accessor("reason", {
    header: "Reason",
    cell: (c) => <Badge variant="outline">{c.getValue()}</Badge>,
  }),
  h.accessor("deltaMicro", {
    header: "Amount",
    cell: (c) => {
      const v = BigInt(c.getValue());
      return (
        <span className={v < 0n ? "tabular-nums text-destructive" : "tabular-nums"}>
          {v > 0n ? "+" : ""}
          {microToCredits(v)}
        </span>
      );
    },
  }),
  h.accessor("note", { header: "Note", cell: (c) => c.getValue() ?? "" }),
] as Columns<LedgerRow>;

export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return <DataTable columns={columns} data={rows} empty="No ledger entries." />;
}
