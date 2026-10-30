"use client";

import { useState } from "react";
import { ChainBar } from "@/components/chain";
import { RegistryVersion } from "@/components/registry-version";
import { HashTicker } from "@/components/hash-ticker";
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
import { channelOptions, channelValue, parseChannelValue } from "@/lib/toolchain/version-options";
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

/** Registry tools: `Latest` or a typed version; applied with a button so typing never queues runs. */
function RegistryChannelCell({ tool }: { tool: ToolRowView }) {
  const { pending, run } = useToolAction();
  const current = channelValue(tool.channel, tool.pinnedVersion);
  const [value, setValue] = useState(current);
  const changed = value !== current && (value === "latest" || value.length > 4);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RegistryVersion
        toolId={tool.toolId}
        label={tool.label}
        value={value}
        onChange={setValue}
        disabled={pending}
      />
      {changed ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
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
          Apply
        </Button>
      ) : null}
    </div>
  );
}

function ChannelCell({ tool }: { tool: ToolRowView }) {
  const { pending, run } = useToolAction();
  if (tool.kind === "registry") return <RegistryChannelCell tool={tool} />;
  const options = channelOptions(tool, tool);
  if (options.length <= 1) {
    return <span className="text-sm">{options[0]?.label ?? "Latest"}</span>;
  }
  return (
    <Select
      value={channelValue(tool.channel, tool.pinnedVersion)}
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
      {tool.installBlockedReason ? (
        <>
          <span className="self-center text-meta text-muted-foreground">
            {tool.installBlockedReason}
          </span>
          <Button size="sm" disabled title={tool.installBlockedReason}>
            Install
          </Button>
        </>
      ) : null}
      {tool.canInstall ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" disabled={pending}>
              Install
            </Button>
          }
          title={`Install ${tool.label}?`}
          description={`${tool.sizeHintMb === null ? "The download size is not known in advance." : `Uses about ${tool.sizeHintMb} MB of workspace disk.`}${wake}`}
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
      {tool.canReinstall && (tool.state === "failed" || tool.kind === "registry") ? (
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
            {t.state === "installing" || t.state === "removing" ? (
              <div className="flex w-32 items-center gap-2">
                <div className="flex-1">
                  <ChainBar value={0.3} active label={`${t.label} ${t.state}`} />
                </div>
                <HashTicker active length={6} className="text-muted-foreground" />
              </div>
            ) : null}
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
          <span className="text-muted-foreground">
            {t.sizeHintMb === null ? "unknown" : `about ${t.sizeHintMb} MB`}
          </span>
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
  registry = false,
}: {
  tools: ToolRowView[];
  asleep: boolean;
  empty: string;
  /** Registry tools have no update check, so the "Latest for channel" column is left out. */
  registry?: boolean;
}) {
  const columns = makeColumns(asleep);
  return (
    <DataTable
      flush
      columns={registry ? columns.filter((c) => c.id !== "target") : columns}
      data={tools}
      empty={empty}
    />
  );
}
