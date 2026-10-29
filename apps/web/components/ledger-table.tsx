"use client";

import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { microToCredits } from "@/lib/money";

export interface LedgerRow {
  id: string;
  createdAt: string;
  reason: string;
  deltaMicro: string;
  note: string | null;
}

const sentence = (v: string) => v.replaceAll("_", " ").replace(/^./, (ch) => ch.toUpperCase());

const h = columnHelper<LedgerRow>();
const columns = [
  h.accessor("createdAt", {
    header: "Date",
    cell: (c) => c.getValue().slice(0, 16).replace("T", " "),
  }),
  h.accessor("reason", {
    header: "Reason",
    cell: (c) => sentence(c.getValue()),
  }),
  h.accessor("deltaMicro", {
    header: () => <span className="block text-right">Amount</span>,
    cell: (c) => {
      const v = BigInt(c.getValue());
      return (
        <span className={v < 0n ? "block text-right text-destructive" : "block text-right"}>
          {v > 0n ? "+" : ""}
          {microToCredits(v)}
        </span>
      );
    },
  }),
  h.accessor("note", {
    header: "Note",
    cell: (c) => <span className="text-muted-foreground">{c.getValue() ?? ""}</span>,
  }),
] as Columns<LedgerRow>;

export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <DataTable
      flush
      columns={columns}
      data={rows}
      empty="No ledger entries yet. Top-ups and charges appear here."
    />
  );
}
