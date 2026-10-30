"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ToolId } from "@agentbox/core/toolchain";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { FleetRow } from "@/lib/admin/toolchain-ops";
import { reconcileAllAction, reconcileWorkspaceAction } from "./actions";

const h = columnHelper<FleetRow>();

function ReconcileButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reconcileWorkspaceAction(slug);
          if (res.ok) {
            toast.success(
              res.data.newRun ? `Reconcile queued for ${slug}` : `${slug} already has a run queued`,
            );
            router.refresh();
          } else toast.error(res.error);
        })
      }
    >
      Reconcile
    </Button>
  );
}

function makeColumns(tools: { toolId: ToolId; label: string }[]): Columns<FleetRow> {
  return [
    h.display({
      id: "workspace",
      header: "Workspace",
      cell: (c) => (
        <div>
          <Link
            href={`/admin/workspaces/${c.row.original.slug}`}
            className="font-mono text-signal hover:underline"
          >
            {c.row.original.slug}
          </Link>
          <div className="text-meta text-muted-foreground">
            {c.row.original.owner ?? "unknown owner"}
          </div>
        </div>
      ),
    }),
    h.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} /> }),
    ...tools.map((t) =>
      h.display({
        id: `tool-${t.toolId}`,
        header: t.label,
        cell: (c) => {
          const cell = c.row.original.cells[t.toolId];
          if (!cell || (!cell.installed && cell.state === "idle")) {
            return <span className="text-muted-foreground">none</span>;
          }
          return (
            <div className="flex flex-col gap-0.5">
              {cell.installed ? <Mono>{cell.installed}</Mono> : null}
              {cell.state === "failed" ||
              cell.state === "pending" ||
              cell.state === "installing" ? (
                <StatusBadge status={cell.state} />
              ) : cell.outdated ? (
                <span className="text-meta text-muted-foreground">outdated</span>
              ) : null}
            </div>
          );
        },
      }),
    ),
    h.display({
      id: "counts",
      header: "Outdated / failed",
      cell: (c) => `${c.row.original.outdated} / ${c.row.original.failed}`,
    }),
    h.display({
      id: "lastRun",
      header: "Last run",
      cell: (c) => {
        const run = c.row.original.lastRun;
        if (!run) return <span className="text-muted-foreground">none</span>;
        const bad = ["failed", "partial", "interrupted"].includes(run.status);
        return (
          <div className="space-y-1">
            <StatusBadge status={run.status} />
            {bad ? (
              <div>
                <Link href="/admin/jobs" className="text-meta text-signal hover:underline">
                  View jobs
                </Link>
              </div>
            ) : null}
          </div>
        );
      },
    }),
    h.display({
      id: "actions",
      header: () => <span className="block text-right">Actions</span>,
      cell: (c) => (
        <div className="flex justify-end">
          <ReconcileButton slug={c.row.original.slug} />
        </div>
      ),
    }),
  ] as Columns<FleetRow>;
}

export function FleetSection({
  fleet,
  tools,
  liveCount,
  runningCount,
}: {
  fleet: FleetRow[];
  tools: { toolId: ToolId; label: string }[];
  liveCount: number;
  runningCount: number;
}) {
  const router = useRouter();
  const [runningOnly, setRunningOnly] = useState(false);
  const count = runningOnly ? runningCount : liveCount;
  return (
    <Section
      title="Fleet"
      description="Installed versions per workspace. Reconcile installs missing tools and applies pin changes; it never upgrades."
      actions={
        <ConfirmDialog
          trigger={
            <Button size="sm" disabled={count === 0}>
              Reconcile all
            </Button>
          }
          title={`Reconcile ${count} ${count === 1 ? "workspace" : "workspaces"}?`}
          description={
            <div className="space-y-3">
              <p>
                {runningOnly
                  ? "Only workspaces that are running now are included."
                  : "Sleeping workspaces are included. Each one is started, billed to its owner as normal awake time, and stopped again by the idle policy. Owners whose plan cannot start a workspace are skipped."}
              </p>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="running-only"
                  checked={runningOnly}
                  onCheckedChange={(v) => setRunningOnly(v === true)}
                />
                <Label htmlFor="running-only">Running workspaces only</Label>
              </div>
            </div>
          }
          confirmLabel={`Reconcile ${count}`}
          onConfirm={async () => {
            const res = await reconcileAllAction(runningOnly);
            if (res.ok) {
              const r = res.data;
              toast.success(
                `Queued ${r.requested}, skipped ${r.skippedNotRunning + r.skippedBlocked}${r.coalesced ? `, ${r.coalesced} already had a run` : ""}`,
              );
              router.refresh();
            }
            return res;
          }}
        />
      }
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <DataTable flush columns={makeColumns(tools)} data={fleet} empty="No workspaces yet." />
      </div>
    </Section>
  );
}
