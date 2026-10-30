import { z } from "zod";
import type { AgentStep } from "./api.ts";
import {
  CATALOG,
  catalogEntry,
  requireEntry,
  toolIdSchema,
  type CatalogEntry,
  type Channel,
  type ToolId,
} from "./catalog.ts";
import { compareVersions, resolveTarget, satisfiesPin, type LatestInfo } from "./versions.ts";

export const TOOL_STATES = [
  "idle",
  "pending",
  "installing",
  "removing",
  "failed",
  /** The image ships this tool; no managed copy exists yet. */
  "external",
] as const;
export type ToolState = (typeof TOOL_STATES)[number];

export interface DesiredRow {
  toolId: string;
  channel: Channel;
  pinnedVersion: string | null;
  desired: boolean;
}

export interface ObservedRow {
  toolId: string;
  state: ToolState;
  installedVersion: string | null;
  previousVersion: string | null;
  /** The mise backend that produced the managed install; null when none exists. */
  backend: string | null;
}

/** One-shot request stored on `workspace_tools.requested_action`; survives job coalescing. */
export const REQUESTED_ACTIONS = ["upgrade", "rollback", "reinstall"] as const;
export type RequestedAction = (typeof REQUESTED_ACTIONS)[number];

export const PLAN_ACTIONS = [
  "install",
  "upgrade",
  "downgrade",
  "reinstall",
  "remove",
  "relink",
  "verify",
] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export const planStepSchema = z.object({
  tool: toolIdSchema,
  action: z.enum(PLAN_ACTIONS),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planSchema = z.object({
  steps: z.array(planStepSchema),
  /** Tools left alone, with the reason (shown in the run drawer). */
  skipped: z.array(z.object({ tool: toolIdSchema, reason: z.string() })),
  /** Desired tools that cannot be planned (no version published, no previous to roll back to). */
  errors: z.array(z.object({ tool: toolIdSchema, reason: z.string() })),
});
export type Plan = z.infer<typeof planSchema>;

export interface PlanInput {
  desired: readonly DesiredRow[];
  observed: readonly ObservedRow[];
  latest: Partial<Record<ToolId, LatestInfo>>;
  /** Catalog entries an admin switched off: never planned. */
  disabled?: readonly ToolId[];
  /** Move these tools to the version their channel resolves to now (`all`: every managed tool). */
  upgrade?: readonly ToolId[] | "all";
  /** Relink these tools to their previous version. */
  rollback?: readonly ToolId[];
  /** Install the resolved version again even when it is already present. */
  reinstall?: readonly ToolId[] | "all";
}

/** A managed install exists (as opposed to a tool the image happens to ship). */
export const isManaged = (
  o: ObservedRow | undefined,
): o is ObservedRow & { installedVersion: string; backend: string } =>
  !!o && o.backend !== null && o.installedVersion !== null && o.state !== "external";

const wants = (list: readonly ToolId[] | "all" | undefined, id: ToolId) =>
  list === "all" || (Array.isArray(list) && list.includes(id));

/**
 * Diff desired against observed state. Reconciling never upgrades on its own: a `latest`/`lts`
 * channel moves only when the caller asks (`upgrade`), so starting a workspace cannot change
 * versions under a running project. Missing tools are installed, pin changes are applied, and
 * tools switched off are removed. Runtimes are ordered before agent CLIs.
 */
export function buildPlan(input: PlanInput): Plan {
  const disabled = new Set(input.disabled ?? []);
  const desired = new Map(input.desired.map((d) => [d.toolId, d]));
  const observed = new Map(input.observed.map((o) => [o.toolId, o]));
  const steps: PlanStep[] = [];
  const skipped: Plan["skipped"] = [];
  const errors: Plan["errors"] = [];

  // Registry tools are not in CATALOG: every desired `mise:<name>` row is planned after the curated ones.
  const registry = input.desired.flatMap((d) => {
    const e = d.toolId.startsWith("mise:") ? catalogEntry(d.toolId) : undefined;
    return e?.kind === "registry" ? [e] : [];
  });
  for (const entry of [...CATALOG, ...registry]) {
    const id = entry.id;
    const want = desired.get(id);
    const have = observed.get(id);
    if (!want) continue;
    if (disabled.has(id)) {
      skipped.push({ tool: id, reason: "disabled by an administrator" });
      continue;
    }
    const managed = isManaged(have);

    if (wants(input.rollback, id)) {
      if (!managed) errors.push({ tool: id, reason: "nothing is installed to roll back" });
      else if (!have.previousVersion)
        errors.push({ tool: id, reason: "no previous version is kept" });
      else
        steps.push({
          tool: id,
          action: "relink",
          from: have.installedVersion,
          to: have.previousVersion,
        });
      continue;
    }

    if (!want.desired) {
      if (managed)
        steps.push({ tool: id, action: "remove", from: have.installedVersion, to: null });
      continue;
    }

    const language = entry.requires ? desired.get(entry.requires) : undefined;
    if (entry.requires && want.desired && !language?.desired) {
      skipped.push({ tool: id, reason: `requires ${requireEntry(entry.requires).label}` });
      continue;
    }

    const target = resolveTarget(entry, want.channel, want.pinnedVersion, input.latest[id]);
    if (!target.ok) {
      if (managed) skipped.push({ tool: id, reason: target.reason });
      else errors.push({ tool: id, reason: target.reason });
      continue;
    }

    if (!managed) {
      steps.push({
        tool: id,
        action: "install",
        from: have?.installedVersion ?? null,
        to: target.version,
      });
      continue;
    }
    const installed = have.installedVersion;
    const pinDrift =
      want.channel === "pin" &&
      !!want.pinnedVersion &&
      !satisfiesPin(entry, want.pinnedVersion, installed);
    // Registry `latest` has no version list to compare: upgrading always reinstalls the newest.
    const followsLatest = entry.kind === "registry" && want.channel === "latest";
    if (wants(input.reinstall, id)) {
      steps.push({ tool: id, action: "reinstall", from: installed, to: target.version });
    } else if (
      pinDrift ||
      (wants(input.upgrade, id) &&
        (followsLatest || (entry.kind !== "registry" && installed !== target.version)))
    ) {
      steps.push({
        tool: id,
        action:
          followsLatest || compareVersions(target.version, installed) >= 0
            ? "upgrade"
            : "downgrade",
        from: installed,
        to: target.version,
      });
    }
  }

  // Tools no longer in the catalog's desired set but still managed are handled by the caller
  // (removal rows keep `desired=false`), so nothing else is planned here.
  const kindRank = { runtime: 0, "package-manager": 500, agent: 1000, registry: 2000 } as const;
  const rank = new Map([...CATALOG, ...registry].map((e, i) => [e.id, kindRank[e.kind] + i]));
  steps.sort((a, b) => (rank.get(a.tool) ?? 0) - (rank.get(b.tool) ?? 0));
  return { steps, skipped, errors };
}

/** A newer version is available for a managed tool whose channel follows releases. */
export function updateAvailable(
  entry: CatalogEntry,
  want: Pick<DesiredRow, "channel" | "pinnedVersion">,
  have: ObservedRow | undefined,
  info: LatestInfo | undefined,
): string | null {
  if (!isManaged(have) || entry.versionSource.kind === "none") return null;
  const target = resolveTarget(entry, want.channel, want.pinnedVersion, info);
  if (!target.ok) return null;
  return compareVersions(target.version, have.installedVersion) > 0 ? target.version : null;
}

/** The wire step the host agent executes for a plan step. */
export function toAgentStep(plan: PlanStep, info: LatestInfo | undefined): AgentStep {
  const entry = requireEntry(plan.tool);
  const base = {
    tool: entry.id,
    bins: entry.bins.map((b) => ({
      name: b.name,
      ...(b.file ? { file: b.file } : {}),
      optional: b.optional ?? false,
    })),
    versionArgs: entry.versionArgs,
    ...(entry.kind === "registry" ? { registry: true } : {}),
  };
  switch (plan.action) {
    case "remove":
      return { ...base, action: "remove", version: null, backends: [] };
    case "relink":
      return { ...base, action: "relink", version: plan.to, backends: [] };
    case "verify":
      return { ...base, action: "verify", version: null, backends: [] };
    default: {
      const options =
        entry.versionSource.kind === "muse-channel" && info?.meta?.["url"] && info.meta["checksum"]
          ? { url: info.meta["url"], checksum: info.meta["checksum"] }
          : undefined;
      return {
        ...base,
        action: "install",
        version: plan.to,
        backends: entry.backends.map((b) => ({ spec: b.spec, ...(options ? { options } : {}) })),
      };
    }
  }
}

/** Steps to inspect what the workspace actually has, including image-provided tools. */
export function verifySteps(ids: readonly ToolId[] = CATALOG.map((e) => e.id)): PlanStep[] {
  return ids.map((tool) => ({ tool, action: "verify", from: null, to: null }));
}

/** Run lifecycle as stored in `toolchain_runs.status`. */
export const RUN_STATUSES = [
  /** Enqueued; the worker has not picked it up. */
  "queued",
  /** Workspace is asleep; an automatic start was requested and the run begins after it. */
  "waiting",
  "running",
  "succeeded",
  "partial",
  "failed",
  /** Container stopped or restarted mid-run; retried at the next start. */
  "interrupted",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
