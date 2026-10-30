import { z } from "zod";
import type { CatalogEntry, Channel } from "./catalog.ts";

/** Stable releases only: `1.2.3`, plus Muse's `1.4.14-R7309.1` revision form. */
const STABLE_RE = /^\d+\.\d+\.\d+(?:-R\d+(?:\.\d+)?)?$/;
export const isStableVersion = (v: string) => STABLE_RE.test(v);

/** Numeric dotted comparison (`-R7309.1` revisions compare as extra numeric segments). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]R?/).map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(/[.-]R?/).map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest first, stable releases only, de-duplicated. */
export function sortStable(versions: readonly string[]): string[] {
  return [...new Set(versions.filter(isStableVersion))].sort((a, b) => compareVersions(b, a));
}

/** First version in output like `claude 2.1.314 (Claude Code)` or `v24.22.2`. */
export function parseVersionOutput(output: string): string | null {
  const m = /\bv?(\d+\.\d+\.\d+(?:-R\d+(?:\.\d+)?)?)\b/.exec(output);
  return m ? (m[1] as string) : null;
}

export interface VersionLine {
  /** `major.minor`, e.g. `3.12`. */
  line: string;
  /** Newest patch in the line. */
  latest: string;
}

/** Recent `major.minor` lines, newest first, each with its newest patch. */
export function versionLines(versions: readonly string[], max: number): VersionLine[] {
  const out: VersionLine[] = [];
  const seen = new Set<string>();
  for (const v of sortStable(versions)) {
    const [maj, min] = v.split(".");
    const line = `${maj}.${min}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ line, latest: v });
    if (out.length >= max) break;
  }
  return out;
}

export const isLine = (v: string) => /^\d+(?:\.\d+)?$/.test(v);

/** What the central worker knows about a tool's published versions (`tool_latest` row). */
export interface LatestInfo {
  /** Newest stable release. */
  latest: string | null;
  /** Newest LTS release (Node only). */
  lts: string | null;
  /** Newest-first stable versions (bounded). */
  versions: string[];
  /** Source-specific data the install needs (Muse download url + checksum). */
  meta?: Record<string, string> | null;
}

export type Resolution = { ok: true; version: string } | { ok: false; reason: string };

/**
 * The exact version a desired state resolves to. A pinned `major.minor` (or `major`) line resolves
 * to the newest patch in that line; a pinned exact version must be one the source publishes.
 */
export function resolveTarget(
  entry: CatalogEntry,
  channel: Channel,
  pinned: string | null | undefined,
  info: LatestInfo | undefined,
): Resolution {
  if (!info || (info.versions.length === 0 && !info.latest)) {
    return { ok: false, reason: `no published versions known for ${entry.label} yet` };
  }
  if (channel === "latest") {
    return info.latest
      ? { ok: true, version: info.latest }
      : { ok: false, reason: `no latest release known for ${entry.label}` };
  }
  if (channel === "lts") {
    if (!entry.channels.includes("lts"))
      return { ok: false, reason: `${entry.label} has no LTS channel` };
    return info.lts
      ? { ok: true, version: info.lts }
      : { ok: false, reason: `no LTS release known for ${entry.label}` };
  }
  if (!pinned) return { ok: false, reason: "no version selected" };
  if (!entry.channels.includes("pin"))
    return { ok: false, reason: `${entry.label} cannot be pinned` };
  if (entry.lines && isLine(pinned)) {
    const match = info.versions.find((v) => v === pinned || v.startsWith(`${pinned}.`));
    return match
      ? { ok: true, version: match }
      : { ok: false, reason: `no ${entry.label} ${pinned}.x release is published` };
  }
  if (info.versions.includes(pinned) || info.latest === pinned) return { ok: true, version: pinned };
  return { ok: false, reason: `${entry.label} ${pinned} is not among the published versions` };
}

/** Whether an installed version already satisfies a pin (a line is satisfied by any patch in it). */
export function satisfiesPin(entry: CatalogEntry, pinned: string, installed: string): boolean {
  if (entry.lines && isLine(pinned)) return installed === pinned || installed.startsWith(`${pinned}.`);
  return installed === pinned;
}

/** How many versions to keep per tool in `tool_latest.versions`. */
export function versionsToKeep(entry: CatalogEntry): number {
  return entry.lines ? 150 : 30;
}

/** Lines a user may pick for a tool, newest first (empty for tools without line selection). */
export function selectableLines(entry: CatalogEntry, versions: readonly string[]): VersionLine[] {
  return entry.lines ? versionLines(versions, entry.id === "python" ? 8 : 12) : [];
}

/** Exact versions a user may pin an agent/bun to (recent, newest first). */
export function selectablePins(entry: CatalogEntry, versions: readonly string[]): string[] {
  return entry.lines ? [] : sortStable(versions).slice(0, 15);
}

/* ---------------- source parsers (pure; the worker owns the network) ---------------- */

const nodeIndexSchema = z.array(
  z.object({ version: z.string(), lts: z.union([z.string(), z.literal(false)]) }).loose(),
);

export function parseNodeIndex(json: unknown): LatestInfo {
  const rows = nodeIndexSchema.parse(json).map((r) => ({
    version: r.version.replace(/^v/, ""),
    lts: r.lts !== false,
  }));
  const stable = rows.filter((r) => isStableVersion(r.version));
  const versions = sortStable(stable.map((r) => r.version));
  const lts = sortStable(stable.filter((r) => r.lts).map((r) => r.version))[0] ?? null;
  return { latest: versions[0] ?? null, lts, versions };
}

export function parsePythonList(text: string): LatestInfo {
  const versions = sortStable(text.split("\n").map((l) => l.trim()));
  return { latest: versions[0] ?? null, lts: null, versions };
}

const packumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string()).optional(),
  versions: z.record(z.string(), z.unknown()),
});

/** npm packument: `latest` follows the registry dist-tag when it is a stable release. */
export function parseNpmPackument(json: unknown): LatestInfo {
  const p = packumentSchema.parse(json);
  const versions = sortStable(Object.keys(p.versions));
  const tagged = p["dist-tags"]?.["latest"];
  const latest = tagged && isStableVersion(tagged) ? tagged : (versions[0] ?? null);
  return { latest, lts: null, versions };
}

const museChannelSchema = z.object({
  version: z.string(),
  manifest_url: z.string().url(),
});
const museManifestSchema = z.object({
  version: z.string(),
  artifacts: z.record(z.string(), z.object({ url: z.string().url(), checksum: z.string() })),
});

export const MUSE_CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";

export function parseMuseChannel(json: unknown): { version: string; manifestUrl: string } {
  const c = museChannelSchema.parse(json);
  return { version: c.version, manifestUrl: c.manifest_url };
}

export function parseMuseManifest(json: unknown): LatestInfo {
  const m = museManifestSchema.parse(json);
  const art = m.artifacts["x86_linux"];
  if (!art) throw new Error("muse manifest has no x86_linux artifact");
  return {
    latest: m.version,
    lts: null,
    versions: [m.version],
    meta: { url: art.url, checksum: `sha256:${art.checksum}` },
  };
}
