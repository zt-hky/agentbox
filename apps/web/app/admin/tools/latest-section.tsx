"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import type { LatestStatusRow } from "@/lib/admin/toolchain-ops";
import { refreshLatestAction } from "./actions";

const h = columnHelper<LatestStatusRow>();
const columns = [
  h.accessor("label", { header: "Tool" }),
  h.accessor("latest", {
    header: "Latest",
    cell: (c) =>
      c.getValue() ? (
        <Mono>{c.getValue()}</Mono>
      ) : (
        <span className="text-muted-foreground">unknown</span>
      ),
  }),
  h.accessor("lts", {
    header: "LTS",
    cell: (c) =>
      c.getValue() ? (
        <Mono>{c.getValue()}</Mono>
      ) : (
        <span className="text-muted-foreground">none</span>
      ),
  }),
  h.accessor("versionCount", { header: "Versions kept" }),
  h.accessor("checkedAt", {
    header: "Last checked",
    cell: (c) =>
      c.getValue() ? (
        `${c.getValue()!.slice(0, 16).replace("T", " ")} UTC`
      ) : (
        <span className="text-muted-foreground">never</span>
      ),
  }),
  h.accessor("error", {
    header: "Last error",
    cell: (c) =>
      c.getValue() ? (
        <span className="line-clamp-2 max-w-md whitespace-normal text-destructive">
          {c.getValue()}
        </span>
      ) : (
        <span className="text-muted-foreground">none</span>
      ),
  }),
] as Columns<LatestStatusRow>;

export function LatestSection({ rows }: { rows: LatestStatusRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () =>
    start(async () => {
      const res = await refreshLatestAction();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const { refreshed, failed } = res.data;
      if (failed.length > 0) {
        toast.error(
          `${refreshed.length} refreshed, ${failed.length} failed: ${failed.map((f) => f.toolId).join(", ")}`,
        );
      } else {
        toast.success(`${refreshed.length} tools refreshed`);
      }
      router.refresh();
    });
  return (
    <Section
      title="Published versions"
      description="Cached from each tool's source. A failed check keeps the previous versions."
      actions={
        <Button size="sm" variant="outline" disabled={pending} onClick={refresh}>
          Refresh now
        </Button>
      }
      bodyClassName="p-0"
    >
      <DataTable flush columns={columns} data={rows} />
    </Section>
  );
}
