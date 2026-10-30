"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Channel, ToolDefault, ToolId } from "@agentbox/core/toolchain";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CatalogAdminRow } from "@/lib/admin/toolchain-ops";
import { saveSetting } from "../settings/actions";

const CHANNEL_LABEL: Record<Channel, string> = { latest: "Latest", lts: "LTS", pin: "Pinned" };

interface Draft {
  enabled: boolean;
  install: boolean;
  channel: Channel;
  pin: string;
}

export function CatalogForm({ catalog }: { catalog: CatalogAdminRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      catalog.map((c) => [
        c.toolId,
        {
          enabled: !c.disabled,
          install: c.defaultChannel !== null,
          channel: c.defaultChannel ?? c.channels[0] ?? "latest",
          pin: c.defaultPin ?? "",
        },
      ]),
    ),
  );
  const patch = (id: ToolId, p: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] as Draft), ...p } }));

  const save = () =>
    start(async () => {
      const defaults: ToolDefault[] = [];
      const disabled: ToolId[] = [];
      for (const c of catalog) {
        const d = drafts[c.toolId] as Draft;
        if (!d.enabled) {
          disabled.push(c.toolId);
          continue;
        }
        if (!d.install) continue;
        defaults.push(
          d.channel === "pin"
            ? { tool: c.toolId, channel: "pin", pinnedVersion: d.pin.trim() }
            : { tool: c.toolId, channel: d.channel },
        );
      }
      const res = await saveSetting("toolchain", { defaults, disabled });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Tool settings saved");
        router.refresh();
      }
    });

  return (
    <Section
      title="Catalog and defaults"
      description="Turn a tool off to hide it from every workspace. Defaults seed a workspace's tool list the first time it is needed; choices users already made are kept and nothing is upgraded."
      actions={
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
      }
      bodyClassName="p-0"
    >
      <Table>
        <TableHeader className="bg-rack">
          <TableRow>
            <TableHead className="h-9 pl-5 text-meta font-medium text-muted-foreground">
              Tool
            </TableHead>
            <TableHead className="h-9 text-meta font-medium text-muted-foreground">
              Available
            </TableHead>
            <TableHead className="h-9 text-meta font-medium text-muted-foreground">
              Install by default
            </TableHead>
            <TableHead className="h-9 text-meta font-medium text-muted-foreground">
              Channel
            </TableHead>
            <TableHead className="h-9 pr-5 text-meta font-medium text-muted-foreground">
              Pinned version
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {catalog.map((c) => {
            const d = drafts[c.toolId] as Draft;
            const active = d.enabled && d.install;
            return (
              <TableRow key={c.toolId}>
                <TableCell className="pl-5 font-medium">{c.label}</TableCell>
                <TableCell>
                  <Checkbox
                    checked={d.enabled}
                    aria-label={`${c.label} available`}
                    onCheckedChange={(v) => patch(c.toolId, { enabled: v === true })}
                  />
                </TableCell>
                <TableCell>
                  <Checkbox
                    checked={d.install}
                    disabled={!d.enabled}
                    aria-label={`${c.label} installed by default`}
                    onCheckedChange={(v) => patch(c.toolId, { install: v === true })}
                  />
                </TableCell>
                <TableCell>
                  <Select
                    value={d.channel}
                    disabled={!active}
                    onValueChange={(v) => patch(c.toolId, { channel: v as Channel })}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-32"
                      aria-label={`${c.label} default channel`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {c.channels.map((ch) => (
                        <SelectItem key={ch} value={ch}>
                          {CHANNEL_LABEL[ch]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="pr-5">
                  {d.channel === "pin" ? (
                    <>
                      <Input
                        value={d.pin}
                        disabled={!active}
                        list={`pins-${c.toolId}`}
                        placeholder={c.lines ? "3.12" : "1.2.3"}
                        aria-label={`${c.label} pinned version`}
                        className="h-8 w-36 font-mono"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => patch(c.toolId, { pin: e.target.value })}
                      />
                      <datalist id={`pins-${c.toolId}`}>
                        {c.suggestions.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}
