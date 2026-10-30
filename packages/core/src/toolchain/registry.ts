import type { CatalogEntry } from "./catalog.ts";
import snapshot from "./mise-registry.json" with { type: "json" };

/**
 * The mise registry (`mise registry`) as of the mise version the workspace image pins, minus the
 * curated catalog tools. Regenerate with `packages/core/scripts/gen-mise-registry.ts` whenever the
 * image's mise is bumped (docs/toolchain.md). A registry tool's id is `mise:<name>`.
 */
export interface RegistryTool {
  name: string;
  /** mise backends in preference order; the first one is installed from. */
  backends: string[];
  aliases?: string[];
  description?: string;
}

export const REGISTRY: readonly RegistryTool[] = snapshot;

export const REGISTRY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const REGISTRY_ID_RE = /^mise:[a-z0-9][a-z0-9._-]{0,63}$/;
/** Versions a user may type for a registry tool; interpolated into `mise install <spec>@<version>`. */
export const REGISTRY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export type RegistryToolId = `mise:${string}`;

const BY_NAME = new Map(REGISTRY.map((t) => [t.name, t]));

/** Registry tools one workspace may want at once (keeps a reconcile plan within the agent's step cap). */
export const REGISTRY_TOOL_LIMIT = 16;

export const registryToolId = (name: string): RegistryToolId => `mise:${name}`;

/** The snapshot entry behind a `mise:<name>` id; undefined for malformed ids and unknown names. */
export function registryTool(id: string): RegistryTool | undefined {
  return REGISTRY_ID_RE.test(id) ? BY_NAME.get(id.slice(5)) : undefined;
}

export const isRegistryToolId = (id: string): id is RegistryToolId => !!registryTool(id);

const ENTRIES = new Map<string, CatalogEntry>();

/** A catalog-shaped entry for a registry tool: no bins, no version source, `latest` or a typed pin. */
export function registryCatalogEntry(id: string): CatalogEntry | undefined {
  const cached = ENTRIES.get(id);
  if (cached) return cached;
  const tool = registryTool(id);
  const backend = tool?.backends[0];
  if (!tool || !backend) return undefined;
  const entry: CatalogEntry = {
    id: id as RegistryToolId,
    kind: "registry",
    label: tool.name,
    description: tool.description ?? `${tool.name} from the mise registry.`,
    bins: [],
    versionArgs: [],
    backends: [{ spec: backend }],
    versionSource: { kind: "none" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: null,
    sizeHintMb: null,
  };
  ENTRIES.set(id, entry);
  return entry;
}

export interface RegistryHit {
  id: RegistryToolId;
  name: string;
  backend: string;
  description: string;
}

export const REGISTRY_SEARCH_LIMIT = 20;

/**
 * Top matches for a query: name prefix, then alias prefix, then name substring, then alias
 * substring; shorter names first within a group. An empty query matches nothing.
 */
export function searchRegistry(query: string, limit = REGISTRY_SEARCH_LIMIT): RegistryHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const scored: { tool: RegistryTool; rank: number }[] = [];
  for (const tool of REGISTRY) {
    const aliases = tool.aliases ?? [];
    let rank = -1;
    if (tool.name.startsWith(q)) rank = 0;
    else if (aliases.some((a) => a.startsWith(q))) rank = 1;
    else if (tool.name.includes(q)) rank = 2;
    else if (aliases.some((a) => a.includes(q))) rank = 3;
    if (rank >= 0) scored.push({ tool, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.tool.name.length - b.tool.name.length ||
      a.tool.name.localeCompare(b.tool.name),
  );
  return scored.slice(0, limit).flatMap(({ tool }) => {
    const backend = tool.backends[0];
    if (!backend) return [];
    return [
      {
        id: registryToolId(tool.name),
        name: tool.name,
        backend,
        description: tool.description ?? "",
      },
    ];
  });
}
