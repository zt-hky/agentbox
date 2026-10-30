"use client";

import { useEffect, useState } from "react";
import { registryToolVersions } from "@/app/registry-actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/** One lookup per tool per page load, shared by every control showing that tool. */
const lookups = new Map<string, Promise<string[]>>();

function lookupVersions(toolId: string): Promise<string[]> {
  let p = lookups.get(toolId);
  if (!p) {
    p = registryToolVersions(toolId).catch(() => []);
    lookups.set(toolId, p);
    // an empty answer (no source, or the network failed) is worth asking again next time
    void p.then((v) => {
      if (v.length === 0 && lookups.get(toolId) === p) lookups.delete(toolId);
    });
  }
  return p;
}

const OTHER = "other";
const LOADING = "loading";

/**
 * `latest`, `pin:<version>`: the same values the other version selects hold. Versions load lazily
 * when the control mounts; `Other version…` (and any pin the source does not list, or every pin
 * when it lists nothing) shows a text input.
 */
export function RegistryVersion({
  toolId,
  label,
  value,
  onChange,
  disabled,
}: {
  toolId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [versions, setVersions] = useState<string[] | null>(null);
  const [other, setOther] = useState(false);

  useEffect(() => {
    let live = true;
    void lookupVersions(toolId).then((v) => {
      if (live) setVersions(v);
    });
    return () => {
      live = false;
    };
  }, [toolId]);

  const pinned = value.startsWith("pin:");
  const typed = pinned ? value.slice(4) : "";
  const showInput = other || (pinned && versions !== null && !versions.includes(typed));
  const selected = versions === null ? LOADING : showInput ? OTHER : pinned ? value : "latest";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={selected}
        onValueChange={(v) => {
          if (v === OTHER) {
            setOther(true);
            onChange(`pin:${typed}`);
          } else {
            setOther(false);
            onChange(v);
          }
        }}
        disabled={disabled || versions === null}
      >
        <SelectTrigger size="sm" className="w-44" aria-label={`${label} version`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions === null ? (
            <SelectItem value={LOADING}>Loading versions</SelectItem>
          ) : (
            <>
              <SelectItem value="latest">Latest</SelectItem>
              {versions.map((v) => (
                <SelectItem key={v} value={`pin:${v}`}>
                  {v}
                </SelectItem>
              ))}
              <SelectItem value={OTHER}>Other version…</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {showInput && versions !== null ? (
        <Input
          aria-label={`${label} version number`}
          placeholder="e.g. 1.2.3"
          className="h-8 w-32 font-mono text-xs"
          value={typed}
          maxLength={64}
          disabled={disabled}
          onChange={(e) => onChange(`pin:${e.target.value.trim()}`)}
        />
      ) : null}
    </div>
  );
}
