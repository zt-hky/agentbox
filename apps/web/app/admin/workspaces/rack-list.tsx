"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusLight, statusLabel } from "@/components/status-light";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceModule } from "@/components/workspace-module";
import { AdminSleepButton } from "./admin-sleep-button";
import {
  RACK_SORTS,
  filterRackRows,
  sortRackRows,
  statusCounts,
  type RackRow,
  type RackSort,
} from "@/lib/admin/workspaces";

// Mirrors the grid in WorkspaceModule's row variant so the column labels line up with its cells.
const HEADER_GRID =
  "md:grid-cols-[minmax(10rem,1.2fr)_minmax(8rem,1fr)_repeat(3,minmax(6rem,1fr))_auto]";

const IMAGE_CHIP: Record<NonNullable<RackRow["image"]>["state"], string | null> = {
  active: null,
  outdated: "Outdated",
  pinned: "Pinned",
  "pinned-pending": "Pinned, pending",
  unknown: null,
};

/** Short image id (plus ref on wide screens) with an Outdated/Pinned flag when it is not simply active. */
function RackImageChip({ image }: { image: RackRow["image"] }) {
  if (!image || !image.shortId) return null;
  const flag = IMAGE_CHIP[image.state];
  return (
    <span
      className="hidden items-center gap-1.5 text-meta text-muted-foreground lg:inline-flex"
      title={image.t3Ref ? `${image.t3Ref} · ${image.shortId}` : image.shortId}
    >
      <span className="font-mono">{image.shortId.slice(0, 8)}</span>
      {flag ? (
        <Badge variant={image.state === "outdated" ? "destructive" : "outline"}>{flag}</Badge>
      ) : null}
    </span>
  );
}

export function RackList({ rows, now }: { rows: RackRow[]; now: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<RackSort>("slug");
  const nowDate = useMemo(() => new Date(now), [now]);
  const chips = useMemo(() => statusCounts(rows), [rows]);
  const visible = useMemo(
    () => sortRackRows(filterRackRows(rows, { status, query }), sort),
    [rows, status, query, sort],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No workspaces yet"
        description="Approve an access request; the user creates the workspace in setup."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/requests">Open access requests</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by slug or email"
          aria-label="Search workspaces by slug or email"
          className="w-full sm:w-72"
        />
        <div className="flex items-center gap-2 sm:ml-auto">
          <span className="text-meta text-muted-foreground" id="rack-sort-label">
            Sort by
          </span>
          <Select value={sort} onValueChange={(v) => setSort(v as RackSort)}>
            <SelectTrigger className="w-40" aria-labelledby="rack-sort-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RACK_SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {chips.map((c) => (
          <Button
            key={c.status}
            size="sm"
            variant={status === c.status ? "secondary" : "outline"}
            aria-pressed={status === c.status}
            onClick={() => setStatus(c.status)}
          >
            {c.status === "all" ? null : <StatusLight status={c.status} size="sm" label={null} />}
            {c.status === "all" ? "All" : statusLabel(c.status)}
            <span className="text-muted-foreground">{c.count}</span>
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No workspace matches"
          description="Clear the search or pick another status to see the rest."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid gap-2">
          <div
            aria-hidden="true"
            className={`hidden gap-x-6 px-4 text-meta text-muted-foreground md:grid ${HEADER_GRID}`}
          >
            <span>Workspace</span>
            <span>Owner</span>
            <span>CPU</span>
            <span>Memory</span>
            <span>Disk</span>
            <span />
          </div>
          {visible.map((r) => (
            <WorkspaceModule
              key={r.slug}
              variant="row"
              href={`/admin/workspaces/${r.slug}`}
              now={nowDate}
              ws={{
                slug: r.slug,
                status: r.status,
                owner: r.ownerEmail,
                plan: r.planName,
                lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
                awakeSince: r.awakeSince ? new Date(r.awakeSince) : null,
              }}
              live={{ cpuCores: r.cpuCores, memBytes: r.memBytes, diskBytes: r.diskBytes }}
              limits={r.limits}
              actions={
                <>
                  <RackImageChip image={r.image} />
                  <AdminSleepButton slug={r.slug} status={r.status} ownerEmail={r.ownerEmail} />
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
