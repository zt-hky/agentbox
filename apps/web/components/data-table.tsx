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
  flush = false,
}: {
  columns: Columns<TData>;
  data: TData[];
  empty?: string;
  /** Drop the outer frame when the table sits edge to edge inside a Section (`bodyClassName="p-0"`). */
  flush?: boolean;
}) {
  const table = useTable({ features, columns, data });
  return (
    <div
      className={
        flush
          ? "overflow-hidden [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5"
          : "overflow-hidden rounded-lg border"
      }
    >
      <Table>
        <TableHeader className="bg-rack">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className="h-9 text-meta font-medium text-muted-foreground"
                >
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
