import { eq } from "drizzle-orm";
import {
  CATALOG,
  catalogEntry,
  type CatalogEntry,
  type Channel,
  type ToolId,
  REGISTRY_TOOL_LIMIT,
  REGISTRY_VERSION_RE,
} from "@agentbox/core/toolchain";
import { loadToolchainSettings } from "@agentbox/db/toolchain";
import { user, workspaceTools, workspaces } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";
import { UserError } from "./errors";
import { validateSelection } from "./toolchain/ops";
import { loadLatestMap } from "./toolchain/view";

export type SelectionKind = CatalogEntry["kind"];

/** The two halves of the saved selection; `runtime` holds languages and their package managers. */
export type SelectionHalf = "runtime" | "agent";

/** The channel (and pinned version line) chosen for one tool. */
export interface ChosenVersion {
  channel: Channel;
  pinnedVersion: string | null;
}

export type ChosenVersions = Partial<Record<ToolId, ChosenVersion>>;

export interface ResolvedSelection {
  /** Language runtime ids (kind `runtime`). */
  tools: ToolId[];
  /** Package manager ids (kind `package-manager`) whose language is in `tools`. */
  packageManagers: ToolId[];
  /** Tools picked from the mise registry (`mise:<name>`), saved with the languages. */
  registry: ToolId[];
  /** Agent CLI ids (kind `agent`). */
  agents: ToolId[];
  /** Saved version choices for selected tools; tools without an entry follow the admin default. */
  versions: ChosenVersions;
  /** Whether the user has saved each half explicitly. */
  toolsSaved: boolean;
  agentsSaved: boolean;
}

/** Catalog entries of `kind` that an administrator has not switched off. */
export async function selectableEntries(
  database: DbLike,
  kind: SelectionKind,
): Promise<CatalogEntry[]> {
  const settings = await loadToolchainSettings(database);
  const disabled = new Set<string>(settings.disabled);
  return CATALOG.filter((e) => e.kind === kind && !disabled.has(e.id));
}

/**
 * What the wizard should show as selected: the user's saved choice; else (for a user who already has
 * a workspace) the tools that workspace currently wants; else the admin defaults.
 */
export async function resolveSelection(
  database: DbLike,
  userId: string,
): Promise<ResolvedSelection> {
  const [u] = await database
    .select({ selection: user.onboardingSelection })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const saved = u?.selection ?? null;
  const settings = await loadToolchainSettings(database);
  const disabled = new Set<string>(settings.disabled);
  const usable = (id: string): id is ToolId => {
    const e = catalogEntry(id);
    return !!e && !disabled.has(id);
  };

  let fallback: string[];
  const [ws] = await database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (ws && ws.status !== "deleted") {
    const rows = await database
      .select({ toolId: workspaceTools.toolId, desired: workspaceTools.desired })
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, ws.id));
    fallback = rows.filter((r) => r.desired).map((r) => r.toolId);
  } else {
    fallback = settings.defaults.map((d) => d.tool);
  }

  const pick = (ids: readonly string[] | undefined, kind: SelectionKind): ToolId[] =>
    (ids ?? fallback)
      .filter(usable)
      .filter((id) => catalogEntry(id)?.kind === kind)
      .filter((id, i, all) => all.indexOf(id) === i);
  const tools = pick(saved?.tools, "runtime");
  const packageManagers = pick(saved?.tools, "package-manager").filter((id) => {
    const requires = catalogEntry(id)?.requires;
    return !!requires && tools.includes(requires);
  });
  const registry = pick(saved?.tools, "registry");
  const chosen = new Set<string>([...tools, ...packageManagers, ...registry]);

  const versions: ChosenVersions = {};
  for (const [id, v] of Object.entries(saved?.versions ?? {})) {
    const entry = catalogEntry(id);
    if (!entry || !chosen.has(id) || !entry.channels.includes(v.channel as Channel)) continue;
    if (
      entry.kind === "registry" &&
      v.channel === "pin" &&
      !REGISTRY_VERSION_RE.test(v.pinnedVersion ?? "")
    )
      continue;
    const channel = v.channel as Channel;
    versions[entry.id] = {
      channel,
      pinnedVersion: channel === "pin" ? (v.pinnedVersion ?? null) : null,
    };
  }
  return {
    tools,
    packageManagers,
    registry,
    agents: pick(saved?.agents, "agent"),
    versions,
    toolsSaved: saved?.tools !== undefined,
    agentsSaved: saved?.agents !== undefined,
  };
}

/**
 * Persist one half of the selection; ids must be enabled catalog tools of that half. The `runtime`
 * half takes languages, their package managers and registry tools (`mise:<name>`, at most
 * REGISTRY_TOOL_LIMIT): a package manager whose language is not selected is dropped, and `versions`
 * (validated against the catalog and the published versions) are kept only for selected tools.
 */
export async function saveSelection(
  database: DbLike,
  userId: string,
  kind: SelectionHalf,
  ids: readonly string[],
  versions: ChosenVersions = {},
): Promise<void> {
  const kinds: SelectionKind[] =
    kind === "runtime" ? ["runtime", "package-manager", "registry"] : ["agent"];
  const allowed = new Set<string>();
  for (const k of kinds) {
    if (k !== "registry") for (const e of await selectableEntries(database, k)) allowed.add(e.id);
  }
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const isRegistry = kinds.includes("registry") && catalogEntry(id)?.kind === "registry";
    if (!allowed.has(id) && !isRegistry) throw new UserError(`"${id}" is not available`);
  }
  if (unique.filter((id) => catalogEntry(id)?.kind === "registry").length > REGISTRY_TOOL_LIMIT) {
    throw new UserError(`Pick at most ${REGISTRY_TOOL_LIMIT} tools from the mise registry`);
  }
  const kept = unique.filter((id) => {
    const requires = catalogEntry(id)?.requires;
    return !requires || unique.includes(requires);
  });

  const [u] = await database
    .select({ selection: user.onboardingSelection })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!u) throw new UserError("User not found");

  const latest = await loadLatestMap(database);
  const nextVersions: Record<string, ChosenVersion> = {};
  for (const [id, v] of Object.entries(u.selection?.versions ?? {})) {
    // The other half's choices stay as they were.
    if (!kinds.includes(catalogEntry(id)?.kind ?? "agent")) {
      nextVersions[id] = { channel: v.channel as Channel, pinnedVersion: v.pinnedVersion ?? null };
    }
  }
  for (const [id, v] of Object.entries(versions)) {
    if (!v || !kept.includes(id)) continue;
    const entry = catalogEntry(id);
    if (entry) nextVersions[id] = validateSelection(entry, v, latest.get(entry.id));
  }

  const next = { ...(u.selection ?? {}), [kind === "runtime" ? "tools" : "agents"]: kept };
  if (Object.keys(nextVersions).length > 0) next.versions = nextVersions;
  else delete next.versions;
  await database.update(user).set({ onboardingSelection: next }).where(eq(user.id, userId));
}
