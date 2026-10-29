"use client";

import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import type { ColumnDef, RowData } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Core-only table: AgentBox lists are small and pre-sorted server side. */
export const features = tableFeatures({});
export type TableFeatures = typeof features;
export type Columns<TData extends RowData> = ColumnDef<TableFeatures, TData>[];
export const columnHelper = <TData extends RowData>() => createColumnHelper<TableFeatures, TData>();

export function DataTable<TData extends RowData>({
  columns,
  data,
  empty = "Nothing here yet.",
}: {
  columns: Columns<TData>;
  data: TData[];
  empty?: string;
}) {
  const table = useTable({ features, columns, data });
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-20 text-center text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
