"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/lib/format";
import type { ToolRowView } from "@/lib/toolchain/view";
import {
  installToolAction,
  reinstallToolAction,
  removeToolAction,
  rollbackToolAction,
  selectToolVersionAction,
  upgradeToolAction,
} from "./actions";
import { useToolAction } from "./use-tool-action";

interface Option {
  value: string;
  label: string;
}

/** Channel and pin choices for one tool: `latest`, `lts`, or `pin:<line or version>`. */
export function channelOptions(t: ToolRowView): Option[] {
  const out: Option[] = [];
  if (t.channels.includes("latest")) out.push({ value: "latest", label: "Latest" });
  if (t.channels.includes("lts")) out.push({ value: "lts", label: "LTS" });
  if (t.channels.includes("pin")) {
    for (const l of t.lines) out.push({ value: `pin:${l.line}`, label: `${l.line} (${l.latest})` });
    for (const v of t.pins) out.push({ value: `pin:${v}`, label: `Pinned ${v}` });
  }
  const current = currentChannelValue(t);
  if (!out.some((o) => o.value === current)) {
    out.push({ value: current, label: current.startsWith("pin:") ? current.slice(4) : current });
  }
  return out;
}

export const currentChannelValue = (t: ToolRowView) =>
  t.channel === "pin" ? `pin:${t.pinnedVersion ?? ""}` : t.channel;

export function parseChannelValue(value: string): {
  channel: "latest" | "lts" | "pin";
  pinnedVersion: string | null;
} {
  if (value.startsWith("pin:")) return { channel: "pin", pinnedVersion: value.slice(4) };
  return { channel: value === "lts" ? "lts" : "latest", pinnedVersion: null };
}

function ChannelCell({ tool }: { tool: ToolRowView }) {
  const { pending, run } = useToolAction();
  const options = channelOptions(tool);
  if (options.length <= 1) {
    return <span className="text-sm">{options[0]?.label ?? "Latest"}</span>;
  }
  return (
    <Select
      value={currentChannelValue(tool)}
      disabled={pending}
      onValueChange={(value) =>
        run(
          () =>
            selectToolVersionAction({
              toolId: tool.toolId,
              selection: parseChannelValue(value),
            }),
          `${tool.label} change queued`,
        )
      }
    >
      <SelectTrigger size="sm" className="w-44" aria-label={`${tool.label} channel`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActionsCell({ tool, asleep }: { tool: ToolRowView; asleep: boolean }) {
  const { pending, run, confirm } = useToolAction();
  const wake = asleep
    ? " The workspace is asleep: applying starts it, billed as normal awake time, and the idle policy stops it afterwards."
    : "";
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {tool.canInstall ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" disabled={pending}>
              Install
            </Button>
          }
          title={`Install ${tool.label}?`}
          description={`Uses about ${tool.sizeHintMb} MB of workspace disk.${wake}`}
          confirmLabel="Install"
          onConfirm={confirm(
            () => installToolAction({ toolId: tool.toolId }),
            `${tool.label} install queued`,
          )}
        />
      ) : null}
      {tool.canUpgrade ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(() => upgradeToolAction({ toolId: tool.toolId }), `${tool.label} upgrade queued`)
          }
        >
          Upgrade
        </Button>
      ) : null}
      {tool.canReinstall && tool.state === "failed" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(
              () => reinstallToolAction({ toolId: tool.toolId }),
              `${tool.label} reinstall queued`,
            )
          }
        >
          Reinstall
        </Button>
      ) : null}
      {tool.canRollback ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={pending}>
              Roll back
            </Button>
          }
          title={`Roll back ${tool.label}?`}
          description={`Switches ${tool.label} from ${tool.installedVersion ?? "the current version"} to ${tool.previousVersion ?? "the previous version"}.${wake}`}
          confirmLabel="Roll back"
          onConfirm={confirm(
            () => rollbackToolAction({ toolId: tool.toolId }),
            `${tool.label} rollback queued`,
          )}
        />
      ) : null}
      {tool.canRemove ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={pending}>
              Remove
            </Button>
          }
          title={`Remove ${tool.label}?`}
          description={`Deletes the managed copy of ${tool.label} from your workspace. Your projects are not touched.${wake}`}
          confirmLabel="Remove"
          destructive
          onConfirm={confirm(
            () => removeToolAction({ toolId: tool.toolId }),
            `${tool.label} removal queued`,
          )}
        />
      ) : null}
    </div>
  );
}

const h = columnHelper<ToolRowView>();

function makeColumns(asleep: boolean): Columns<ToolRowView> {
  return [
    h.display({
      id: "tool",
      header: "Tool",
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-medium">{c.row.original.label}</div>
          <div className="text-meta text-muted-foreground">{c.row.original.description}</div>
        </div>
      ),
    }),
    h.display({
      id: "installed",
      header: "Installed",
      cell: (c) => {
        const t = c.row.original;
        if (t.installedVersion) return <Mono>{t.installedVersion}</Mono>;
        return <span className="text-muted-foreground">Not installed</span>;
      },
    }),
    h.display({
      id: "target",
      header: "Latest for channel",
      cell: (c) => {
        const t = c.row.original;
        return (
          <div className="flex flex-wrap items-center gap-2">
            {t.target ? (
              <Mono>{t.target}</Mono>
            ) : (
              <span className="text-meta text-muted-foreground">{t.targetReason ?? "Unknown"}</span>
            )}
            {t.updateAvailable ? <Badge variant="status">Update available</Badge> : null}
          </div>
        );
      },
    }),
    h.display({
      id: "channel",
      header: "Channel",
      cell: (c) => <ChannelCell tool={c.row.original} />,
    }),
    h.display({
      id: "state",
      header: "State",
      cell: (c) => {
        const t = c.row.original;
        return (
          <div className="space-y-1">
            {t.state === "idle" && !t.installedVersion ? null : <StatusBadge status={t.state} />}
            {t.state === "failed" && t.lastError ? (
              <p className="max-w-xs whitespace-normal text-meta text-destructive">{t.lastError}</p>
            ) : null}
          </div>
        );
      },
    }),
    h.display({
      id: "size",
      header: "Size",
      cell: (c) => {
        const t = c.row.original;
        return t.sizeBytes !== null ? (
          formatBytes(t.sizeBytes)
        ) : (
          <span className="text-muted-foreground">about {t.sizeHintMb} MB</span>
        );
      },
    }),
    h.display({
      id: "actions",
      header: () => <span className="block text-right">Actions</span>,
      cell: (c) => <ActionsCell tool={c.row.original} asleep={asleep} />,
    }),
  ] as Columns<ToolRowView>;
}

export function ToolsTable({
  tools,
  asleep,
  empty,
}: {
  tools: ToolRowView[];
  asleep: boolean;
  empty: string;
}) {
  return <DataTable flush columns={makeColumns(asleep)} data={tools} empty={empty} />;
}
