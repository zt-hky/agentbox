import { and, desc, eq, gte } from "drizzle-orm";
import { credentialSpecs, type AgentCredentialSpec } from "@agentbox/core/agent-credentials";
import {
  BUNDLED_PACKAGE_MANAGERS,
  isManaged,
  type CatalogEntry,
  type ToolId,
  type ToolState,
} from "@agentbox/core/toolchain";
import { toolchainRuns, user, workspaceTools, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db, DbLike } from "./db-types";
import { baseDomain, encryptionKey } from "./env";
import { loadGitAccountsView, type GitAccountsView } from "./git-accounts";
import { UserError } from "./errors";
import { listAgentKeys } from "./agent-keys";
import { resolveSelection, selectableEntries } from "./onboarding-selection";
import { loadToolchainSettings } from "@agentbox/db/toolchain";
import {
  channelOptions,
  channelValue,
  versionChoices,
  type VersionOption,
} from "./toolchain/version-options";
import { OPEN_RUN_STATUSES, defaultFor, loadLatestMap, tailLog } from "./toolchain/view";

export type OnboardingStep = "tools" | "agents" | "accounts" | "create";

/** A version select: `latest`, `lts` or `pin:<line>` values; `defaultValue` is the catalog default. */
export interface OnboardingVersionChoice {
  options: VersionOption[];
  value: string;
  defaultValue: string;
}

export interface OnboardingToolOption {
  toolId: ToolId;
  label: string;
  description: string;
  kind: "runtime" | "package-manager" | "agent";
  sizeHintMb: number;
  selected: boolean;
}

/** A package manager the user can install on top of a language, with its own version select. */
export interface OnboardingManagerOption extends OnboardingToolOption {
  kind: "package-manager";
  requires: ToolId;
  version: OnboardingVersionChoice;
}

/** A language: its version select, the package managers it can install and those it ships with. */
export interface OnboardingRuntimeOption extends OnboardingToolOption {
  kind: "runtime";
  version: OnboardingVersionChoice;
  managers: OnboardingManagerOption[];
  bundled: { name: string; detail: string }[];
}

export type AgentCredentialOption = AgentCredentialSpec;

export interface OnboardingAgentOption extends OnboardingToolOption {
  kind: "agent";
  credentials: AgentCredentialOption[];
  saved: { envVar: string; masked: string; updatedAt: string }[];
}

export interface OnboardingState {
  step: OnboardingStep;
  onboarded: boolean;
  tools: OnboardingRuntimeOption[];
  agents: OnboardingAgentOption[];
  selectedToolIds: ToolId[];
  selectedManagerIds: ToolId[];
  selectedAgentIds: ToolId[];
  git: GitAccountsView;
  workspace: { slug: string; status: string; keptData: boolean } | null;
  slug: { value: string; locked: boolean };
  baseDomain: string;
}

export const ONBOARDING_PATH = "/onboarding";

export async function loadOnboardingState(
  database: DbLike,
  userId: string,
  opts: { encryptionKey?: string } = {},
): Promise<OnboardingState> {
  const [u] = await database.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!u) throw new UserError("User not found");
  const selection = await resolveSelection(database, userId);
  const [runtimes, agentEntries, managerEntries, settings, latest] = await Promise.all([
    selectableEntries(database, "runtime"),
    selectableEntries(database, "agent"),
    selectableEntries(database, "package-manager"),
    loadToolchainSettings(database),
    loadLatestMap(database),
  ]);
  const saved = await listAgentKeys(database, userId, opts.encryptionKey ?? encryptionKey());
  const git = await loadGitAccountsView(database, userId);
  const [ws] = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);

  const toOption = (e: CatalogEntry, picked: ToolId[]) => ({
    toolId: e.id,
    label: e.label,
    description: e.description,
    sizeHintMb: e.sizeHintMb,
    selected: picked.includes(e.id),
  });
  const versionChoice = (e: CatalogEntry): OnboardingVersionChoice => {
    const fallback = defaultFor(settings.defaults, e);
    const defaultValue = channelValue(fallback.channel, fallback.pinnedVersion);
    const chosen = selection.versions[e.id];
    const value = chosen ? channelValue(chosen.channel, chosen.pinnedVersion) : defaultValue;
    const options = channelOptions(versionChoices(e, latest.get(e.id)), chosen ?? fallback);
    return {
      options: options.map((o) =>
        o.value === defaultValue ? { ...o, label: `${o.label} (default)` } : o,
      ),
      value,
      defaultValue,
    };
  };
  const managers = (language: CatalogEntry): OnboardingManagerOption[] =>
    managerEntries
      .filter((m) => m.requires === language.id)
      .map((m) => ({
        ...toOption(m, selection.packageManagers),
        kind: "package-manager" as const,
        requires: language.id,
        version: versionChoice(m),
      }));
  const agents: OnboardingAgentOption[] = agentEntries.map((e) => {
    const credentials = credentialSpecs(e.id).map((c) => ({ ...c }));
    return {
      ...toOption(e, selection.agents),
      kind: "agent" as const,
      credentials,
      saved: saved.filter((k) => credentials.some((c) => c.envVar === k.envVar)),
    };
  });

  const live = ws && ws.status !== "deleted" ? ws : null;
  const step: OnboardingStep = !selection.toolsSaved
    ? "tools"
    : !selection.agentsSaved
      ? "agents"
      : live
        ? "create"
        : "accounts";
  return {
    step,
    onboarded: u.onboardedAt !== null,
    tools: runtimes.map((e) => ({
      ...toOption(e, selection.tools),
      kind: "runtime" as const,
      version: versionChoice(e),
      managers: managers(e),
      bundled: [...(BUNDLED_PACKAGE_MANAGERS[e.id] ?? [])],
    })),
    agents,
    selectedToolIds: selection.tools,
    selectedManagerIds: selection.packageManagers,
    selectedAgentIds: selection.agents,
    git,
    workspace: ws ? { slug: ws.slug, status: ws.status, keptData: ws.dataKept } : null,
    slug: {
      value: live || ws?.dataKept ? (ws?.slug ?? "") : (u.reservedSlug ?? ws?.slug ?? ""),
      locked: true,
    },
    baseDomain: baseDomain(),
  };
}

export type OnboardingStage = "provision" | "start" | "tools" | "ready" | "error";
export type StageState = "pending" | "active" | "done" | "failed";
export type ProgressToolState =
  "pending" | "installing" | "installed" | "failed" | "idle" | "external" | "removing";

export interface OnboardingProgress {
  stage: OnboardingStage;
  stages: { id: "provision" | "start" | "tools"; state: StageState }[];
  workspaceStatus: string;
  tools: { toolId: ToolId; label: string; state: ProgressToolState; version: string | null }[];
  steps: { done: number; total: number };
  logTail: string;
  error: string | null;
  canFinish: boolean;
}

const LOG_TICKER_LINES = 12;
const LOG_TICKER_CHARS = 2000;

/** Pure: a tool row's state as the UI shows it (`installed` = settled with a managed copy). */
export function progressToolState(row: {
  state: ToolState;
  desired: boolean;
  installedVersion: string | null;
  backend: string | null;
}): ProgressToolState {
  const observed = {
    toolId: "",
    state: row.state,
    installedVersion: row.installedVersion,
    previousVersion: null,
    backend: row.backend,
  };
  if (row.state === "idle") {
    if (isManaged(observed) && row.desired) return "installed";
    return row.desired ? "pending" : "idle";
  }
  return row.state;
}

export async function loadOnboardingProgress(
  database: DbLike,
  userId: string,
): Promise<OnboardingProgress> {
  const [ws] = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  const empty: OnboardingProgress = {
    stage: "provision",
    stages: [
      { id: "provision", state: "pending" },
      { id: "start", state: "pending" },
      { id: "tools", state: "pending" },
    ],
    workspaceStatus: ws?.status ?? "none",
    tools: [],
    steps: { done: 0, total: 0 },
    logTail: "",
    error: null,
    canFinish: false,
  };
  if (!ws || ws.status === "deleted") return empty;

  const selection = await resolveSelection(database, userId);
  const wanted = new Set<string>([
    ...selection.tools,
    ...selection.packageManagers,
    ...selection.agents,
  ]);
  const [rows, runs, entries] = await Promise.all([
    database.select().from(workspaceTools).where(eq(workspaceTools.workspaceId, ws.id)),
    database
      .select()
      .from(toolchainRuns)
      .where(and(eq(toolchainRuns.workspaceId, ws.id), gte(toolchainRuns.createdAt, ws.createdAt)))
      .orderBy(desc(toolchainRuns.createdAt))
      .limit(5),
    Promise.all([
      selectableEntries(database, "runtime"),
      selectableEntries(database, "package-manager"),
      selectableEntries(database, "agent"),
    ]),
  ]);
  const labels = new Map(entries.flat().map((e) => [e.id as string, e.label]));
  const tools = rows
    .filter((r) => wanted.has(r.toolId) && labels.has(r.toolId))
    .map((r) => ({
      toolId: r.toolId as ToolId,
      label: labels.get(r.toolId) as string,
      state: progressToolState(r),
      version: r.installedVersion,
    }));

  const open = runs.find((r) => (OPEN_RUN_STATUSES as readonly string[]).includes(r.status));
  const current = open ?? runs[0] ?? null;
  const steps = (current?.steps as { status?: string }[] | null) ?? [];
  const planSteps = (current?.plan as { steps?: unknown[] } | null)?.steps?.length ?? 0;
  const settled = Array.isArray(steps) ? steps.filter((s) => s.status !== "running").length : 0;
  const logLines = tailLog(current?.log ?? null)
    .split("\n")
    .slice(-LOG_TICKER_LINES)
    .join("\n");

  const up = ws.status === "running" || ws.status === "sleeping";
  const canFinish = up && !ws.toolchainPending && ws.toolchainGeneration > 0 && !open;
  const runFailed = current?.status === "failed";

  let provision: StageState = ws.status === "provisioning" ? "active" : "done";
  let start: StageState;
  let toolsStage: StageState;
  if (ws.status === "provisioning") {
    start = "pending";
    toolsStage = "pending";
  } else if (ws.status === "error") {
    start = "failed";
    toolsStage = "pending";
  } else if (canFinish) {
    start = "done";
    toolsStage = runFailed ? "failed" : "done";
  } else if (ws.status === "running") {
    start = "done";
    toolsStage = "active";
  } else {
    start = "active";
    toolsStage = "pending";
  }
  if (ws.status === "error") provision = "done";

  const stage: OnboardingStage =
    ws.status === "error"
      ? "error"
      : canFinish
        ? "ready"
        : provision === "active"
          ? "provision"
          : start === "active"
            ? "start"
            : "tools";
  return {
    stage,
    stages: [
      { id: "provision", state: provision },
      { id: "start", state: start },
      { id: "tools", state: toolsStage },
    ],
    workspaceStatus: ws.status,
    tools,
    steps: { done: settled, total: Math.max(planSteps, settled) },
    logTail: logLines.slice(-LOG_TICKER_CHARS),
    error:
      ws.status === "error"
        ? "The workspace could not be started. An administrator can retry it from the console."
        : (current?.error ?? null),
    canFinish,
  };
}

/** Step 4 is done: mark the user onboarded so the dashboard, T3 Code and VS Code open. */
export async function finishOnboarding(
  database: Db,
  userId: string,
  ip: string | null,
  now = new Date(),
): Promise<void> {
  const progress = await loadOnboardingProgress(database, userId);
  if (!progress.canFinish) throw new UserError("Your workspace is not ready yet");
  await database.transaction(async (tx) => {
    await tx.update(user).set({ onboardedAt: now }).where(eq(user.id, userId));
    await writeAudit(tx, {
      actorId: userId,
      action: "onboarding.complete",
      targetType: "user",
      targetId: userId,
      metadata: {},
      ip,
    });
  });
}
