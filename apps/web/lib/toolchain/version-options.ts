import type { CatalogEntry, Channel, LatestInfo } from "@agentbox/core/toolchain";
import { selectableLines, selectablePins } from "@agentbox/core/toolchain";

export interface VersionOption {
  value: string;
  label: string;
}

/** What a version select needs: the channels a tool offers and the lines/pins its source publishes. */
export interface VersionChoices {
  channels: Channel[];
  lines: { line: string; latest: string }[];
  pins: string[];
}

export function versionChoices(entry: CatalogEntry, info: LatestInfo | undefined): VersionChoices {
  const versions = info?.versions ?? [];
  return {
    channels: entry.channels,
    lines: selectableLines(entry, versions),
    pins: selectablePins(entry, versions),
  };
}

/** `latest`, `lts`, or `pin:<line or exact version>`: the value a version select holds. */
export const channelValue = (channel: Channel, pinnedVersion: string | null) =>
  channel === "pin" ? `pin:${pinnedVersion ?? ""}` : channel;

export function parseChannelValue(value: string): {
  channel: Channel;
  pinnedVersion: string | null;
} {
  if (value.startsWith("pin:")) return { channel: "pin", pinnedVersion: value.slice(4) };
  return { channel: value === "lts" ? "lts" : "latest", pinnedVersion: null };
}

/**
 * Channel and pin choices for one tool, shared by the Tools page and onboarding. The current value
 * is always present, even when the source no longer lists it.
 */
export function channelOptions(
  choices: VersionChoices,
  current: { channel: Channel; pinnedVersion: string | null },
): VersionOption[] {
  const out: VersionOption[] = [];
  if (choices.channels.includes("latest")) out.push({ value: "latest", label: "Latest" });
  if (choices.channels.includes("lts")) out.push({ value: "lts", label: "LTS" });
  if (choices.channels.includes("pin")) {
    for (const l of choices.lines) {
      out.push({ value: `pin:${l.line}`, label: `${l.line} (${l.latest})` });
    }
    for (const v of choices.pins) out.push({ value: `pin:${v}`, label: `Pinned ${v}` });
  }
  const value = channelValue(current.channel, current.pinnedVersion);
  if (!out.some((o) => o.value === value)) {
    out.push({ value, label: value.startsWith("pin:") ? value.slice(4) : value });
  }
  return out;
}
