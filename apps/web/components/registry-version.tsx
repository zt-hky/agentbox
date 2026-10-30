"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/** `latest`, or `pin:<typed version>` (the same values the other version selects hold). */
export function RegistryVersion({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const pinned = value.startsWith("pin:");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={pinned ? "pin" : "latest"}
        onValueChange={(v) =>
          onChange(v === "pin" ? `pin:${pinned ? value.slice(4) : ""}` : "latest")
        }
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-40" aria-label={`${label} version`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest">Latest</SelectItem>
          <SelectItem value="pin">Specific version</SelectItem>
        </SelectContent>
      </Select>
      {pinned ? (
        <Input
          aria-label={`${label} version number`}
          placeholder="e.g. 1.2.3"
          className="h-8 w-32 font-mono text-xs"
          value={value.slice(4)}
          maxLength={64}
          disabled={disabled}
          onChange={(e) => onChange(`pin:${e.target.value.trim()}`)}
        />
      ) : null}
    </div>
  );
}
