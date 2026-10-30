import { z } from "zod";
import { isRegistryToolId, registryCatalogEntry, type RegistryToolId } from "./registry.ts";

/**
 * AgentBox-owned catalog of per-workspace tools. Code, not data: the database only stores desired
 * and observed state per tool id. Every install spec below was verified with `mise install` as uid
 * 1000 inside a rootless container (see docs/toolchain.md); backends are listed in the order the
 * agent tries them, and the first one that installs the exact version wins.
 *
 * mise shorthands (`claude`, `codex`, ...) drift between releases, so only explicit backend
 * strings appear here.
 */

export const TOOL_IDS = [
  "node",
  "bun",
  "python",
  "rust",
  "go",
  "java",
  "pnpm",
  "yarn",
  "uv",
  "poetry",
  "maven",
  "gradle",
  "claude",
  "codex",
  "omp",
  "pi",
  "opencode",
  "grok",
  "muse",
  "copilot",
] as const;
/** Curated tools: the catalog below. Registry tools (`mise:<name>`) join them in `ToolId`. */
export type CuratedToolId = (typeof TOOL_IDS)[number];
export type ToolId = CuratedToolId | RegistryToolId;
export const curatedToolIdSchema = z.enum(TOOL_IDS);

/** A curated id, or `mise:<name>` for a name in the mise registry snapshot. */
export const toolIdSchema = z.custom<ToolId>(
  (v) =>
    typeof v === "string" && ((TOOL_IDS as readonly string[]).includes(v) || isRegistryToolId(v)),
  "unknown tool",
);

export const CHANNELS = ["latest", "lts", "pin"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * `package-manager` entries install on top of a language runtime (`requires`); `registry` entries
 * are any other mise registry tool (no bins known up front, no version source).
 */
export type ToolKind = "runtime" | "package-manager" | "agent" | "registry";

/** Where the central worker learns the available versions of a tool. */
export type VersionSource =
  | { kind: "node-dist" }
  | { kind: "python-mise" }
  | { kind: "npm"; pkg: string }
  | { kind: "pypi"; pkg: string }
  | { kind: "maven-central"; group: string; artifact: string }
  | { kind: "go-dl" }
  | { kind: "adoptium" }
  | { kind: "github-releases"; repo: string }
  | { kind: "crates"; crate: string }
  | { kind: "go-proxy"; module: string }
  | { kind: "muse-channel" }
  /** Registry tools: no update check; `latest` resolves on the workspace at install time. */
  | { kind: "none" };

export interface BinDef {
  /** Name linked into the PATH farm (`~/.agentbox/bin/<name>`). */
  name: string;
  /** File inside the install dir when it differs from `name` (the http backend names it `download`). */
  file?: string;
  /** Missing optional bins are skipped instead of failing the install (e.g. `corepack` on Node >= 25). */
  optional?: boolean;
}

export interface BackendDef {
  /** mise backend string, e.g. `aqua:openai/codex`. Never a registry shorthand. */
  spec: string;
}

export interface CatalogEntry {
  id: ToolId;
  kind: ToolKind;
  label: string;
  description: string;
  bins: BinDef[];
  /** argv (after the binary) that prints the version; used by the post-install smoke test. */
  versionArgs: string[];
  backends: BackendDef[];
  versionSource: VersionSource;
  /** Channels a user can choose. `pin` selects an exact version or, with `lines`, a version line. */
  channels: Channel[];
  /** Users may pick an older `major.minor` line; it resolves to the newest patch in that line. */
  lines: boolean;
  /** The T3 provider driver that probes this binary by name (null: not a T3 provider). */
  t3Driver: string | null;
  /** Package managers only: the language runtime this manager belongs to. */
  requires?: ToolId;
  /** Rough installed size, shown before the user confirms; null when unknown (registry tools). */
  sizeHintMb: number | null;
}

const ver = ["--version"];

/** A curated entry: its id is one of `TOOL_IDS`. */
export type CuratedEntry = CatalogEntry & { id: CuratedToolId };

export const CATALOG: readonly CuratedEntry[] = [
  {
    id: "node",
    kind: "runtime",
    label: "Node.js",
    description: "JavaScript runtime with npm, npx and corepack.",
    bins: [
      { name: "node" },
      { name: "npm" },
      { name: "npx" },
      { name: "corepack", optional: true },
    ],
    versionArgs: ver,
    backends: [{ spec: "node" }],
    versionSource: { kind: "node-dist" },
    channels: ["lts", "latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 230,
  },
  {
    id: "bun",
    kind: "runtime",
    label: "Bun",
    description: "JavaScript runtime and package manager.",
    bins: [{ name: "bun" }, { name: "bunx" }],
    versionArgs: ver,
    backends: [{ spec: "bun" }],
    versionSource: { kind: "npm", pkg: "bun" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: null,
    sizeHintMb: 105,
  },
  {
    id: "python",
    kind: "runtime",
    label: "Python",
    description: "Standalone CPython build with pip.",
    bins: [
      { name: "python" },
      { name: "python3" },
      { name: "pip", optional: true },
      { name: "pip3", optional: true },
    ],
    versionArgs: ver,
    backends: [{ spec: "python" }],
    versionSource: { kind: "python-mise" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 105,
  },
  {
    id: "rust",
    kind: "runtime",
    label: "Rust",
    description: "Rust compiler and Cargo, installed with rustup through mise.",
    bins: [
      { name: "rustc" },
      { name: "cargo" },
      { name: "rustfmt", optional: true },
      { name: "rustdoc", optional: true },
    ],
    versionArgs: ver,
    backends: [{ spec: "rust" }],
    versionSource: { kind: "github-releases", repo: "rust-lang/rust" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 1100,
  },
  {
    id: "go",
    kind: "runtime",
    label: "Go",
    description: "Go toolchain.",
    bins: [{ name: "go" }],
    versionArgs: ["version"],
    backends: [{ spec: "go" }],
    versionSource: { kind: "go-dl" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 260,
  },
  {
    id: "java",
    kind: "runtime",
    label: "Java",
    description: "OpenJDK (LTS by default) with javac.",
    bins: [{ name: "java" }, { name: "javac" }],
    versionArgs: ver,
    backends: [{ spec: "java" }],
    versionSource: { kind: "adoptium" },
    channels: ["lts", "latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 330,
  },
  {
    id: "pnpm",
    kind: "package-manager",
    requires: "node",
    label: "pnpm",
    description: "Fast, disk-efficient Node.js package manager.",
    bins: [{ name: "pnpm" }, { name: "pnpx", optional: true }],
    versionArgs: ver,
    backends: [{ spec: "aqua:pnpm/pnpm" }, { spec: "npm:pnpm" }],
    versionSource: { kind: "npm", pkg: "pnpm" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 70,
  },
  {
    id: "yarn",
    kind: "package-manager",
    requires: "node",
    label: "Yarn",
    description: "Yarn package manager for Node.js (4.x, Berry).",
    bins: [{ name: "yarn" }, { name: "yarnpkg", optional: true }],
    versionArgs: ver,
    backends: [{ spec: "aqua:yarnpkg/berry" }, { spec: "npm:@yarnpkg/cli-dist" }],
    versionSource: { kind: "npm", pkg: "@yarnpkg/cli-dist" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 15,
  },
  {
    id: "uv",
    kind: "package-manager",
    requires: "python",
    label: "uv",
    description: "Fast Python package and project manager.",
    bins: [{ name: "uv" }, { name: "uvx", optional: true }],
    versionArgs: ver,
    backends: [{ spec: "aqua:astral-sh/uv" }],
    versionSource: { kind: "github-releases", repo: "astral-sh/uv" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 60,
  },
  {
    id: "poetry",
    kind: "package-manager",
    requires: "python",
    label: "Poetry",
    description: "Python dependency management and packaging.",
    bins: [{ name: "poetry" }],
    versionArgs: ver,
    backends: [{ spec: "pypi:poetry" }],
    versionSource: { kind: "pypi", pkg: "poetry" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 90,
  },
  {
    id: "maven",
    kind: "package-manager",
    requires: "java",
    label: "Maven",
    description: "Apache Maven build tool for Java.",
    bins: [{ name: "mvn" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:apache/maven" }],
    versionSource: { kind: "maven-central", group: "org.apache.maven", artifact: "apache-maven" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 15,
  },
  {
    id: "gradle",
    kind: "package-manager",
    requires: "java",
    label: "Gradle",
    description: "Gradle build tool for Java and Kotlin.",
    bins: [{ name: "gradle" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:gradle/gradle-distributions" }],
    versionSource: { kind: "github-releases", repo: "gradle/gradle" },
    channels: ["latest", "pin"],
    lines: true,
    t3Driver: null,
    sizeHintMb: 140,
  },
  {
    id: "claude",
    kind: "agent",
    label: "Claude Code",
    description: "Anthropic's coding agent CLI.",
    bins: [{ name: "claude" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:anthropics/claude-code" }, { spec: "npm:@anthropic-ai/claude-code" }],
    versionSource: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "claudeAgent",
    sizeHintMb: 280,
  },
  {
    id: "codex",
    kind: "agent",
    label: "Codex",
    description: "OpenAI's coding agent CLI.",
    bins: [{ name: "codex" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:openai/codex" }, { spec: "npm:@openai/codex" }],
    versionSource: { kind: "npm", pkg: "@openai/codex" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "codex",
    sizeHintMb: 410,
  },
  {
    id: "omp",
    kind: "agent",
    label: "Oh My Pi",
    description: "Oh My Pi coding agent (omp).",
    bins: [{ name: "omp" }],
    versionArgs: ver,
    backends: [{ spec: "github:can1357/oh-my-pi" }, { spec: "npm:@oh-my-pi/pi-coding-agent" }],
    versionSource: { kind: "npm", pkg: "@oh-my-pi/pi-coding-agent" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "ohmypi",
    sizeHintMb: 270,
  },
  {
    id: "pi",
    kind: "agent",
    label: "Pi",
    description: "Pi coding agent.",
    bins: [{ name: "pi" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:earendil-works/pi" }, { spec: "npm:@earendil-works/pi-coding-agent" }],
    versionSource: { kind: "npm", pkg: "@earendil-works/pi-coding-agent" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "pi",
    sizeHintMb: 110,
  },
  {
    id: "opencode",
    kind: "agent",
    label: "OpenCode",
    description: "OpenCode coding agent.",
    bins: [{ name: "opencode" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:anomalyco/opencode" }, { spec: "npm:@opencode/cli" }],
    versionSource: { kind: "npm", pkg: "@opencode/cli" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "opencode",
    sizeHintMb: 240,
  },
  {
    id: "grok",
    kind: "agent",
    label: "Grok",
    description: "xAI's Grok CLI.",
    bins: [{ name: "grok" }],
    versionArgs: ver,
    backends: [{ spec: "npm:@xai-official/grok" }],
    versionSource: { kind: "npm", pkg: "@xai-official/grok" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "grok",
    sizeHintMb: 55,
  },
  {
    id: "muse",
    kind: "agent",
    label: "Muse",
    description: "Meta's Muse coding agent (stable channel, Linux x64).",
    bins: [{ name: "muse", file: "download" }],
    versionArgs: ver,
    backends: [{ spec: "http:muse" }],
    versionSource: { kind: "muse-channel" },
    channels: ["latest"],
    lines: false,
    t3Driver: "muse",
    sizeHintMb: 420,
  },
  {
    id: "copilot",
    kind: "agent",
    label: "GitHub Copilot CLI",
    description: "GitHub Copilot CLI; T3 talks to it over ACP (copilot --acp).",
    bins: [{ name: "copilot" }],
    versionArgs: ver,
    backends: [{ spec: "aqua:github/copilot-cli" }, { spec: "npm:@github/copilot" }],
    versionSource: { kind: "npm", pkg: "@github/copilot" },
    channels: ["latest", "pin"],
    lines: false,
    t3Driver: "acpRegistry",
    sizeHintMb: 190,
  },
];

const BY_ID = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.id, e]));

export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id) ?? registryCatalogEntry(id);
}

export function requireEntry(id: string): CatalogEntry {
  const e = catalogEntry(id);
  if (!e) throw new Error(`unknown tool ${id}`);
  return e;
}

/** Installable package managers that belong to a language runtime, in catalog order. */
export function packageManagersFor(language: string): CatalogEntry[] {
  return CATALOG.filter((e) => e.kind === "package-manager" && e.requires === language);
}

/**
 * Package managers that ship inside a language runtime. They are shown as included during onboarding
 * and are never separate catalog tools: no install, no version choice.
 */
export const BUNDLED_PACKAGE_MANAGERS: Readonly<
  Partial<Record<ToolId, readonly { name: string; detail: string }[]>>
> = {
  node: [{ name: "npm", detail: "Bundled with Node.js" }],
  bun: [{ name: "Bun", detail: "Built in: Bun is its own package manager" }],
  python: [{ name: "pip", detail: "Bundled with Python" }],
  rust: [{ name: "Cargo", detail: "Bundled with Rust (rustup)" }],
  go: [{ name: "Go modules", detail: "Built into the Go toolchain" }],
};

/** Image-baked tools the managed copies replace; used to detect `external` installs. */
export const BAKED_TOOL_IDS: readonly CuratedToolId[] = ["node", "claude", "codex", "omp"];

/** Defaults installed for every workspace until an admin changes `toolchain.defaults`. */
export interface ToolDefault {
  tool: CuratedToolId;
  channel: Channel;
  pinnedVersion?: string | null;
}

export const DEFAULT_TOOL_DEFAULTS: readonly ToolDefault[] = [
  { tool: "node", channel: "lts" },
  { tool: "python", channel: "latest" },
  { tool: "bun", channel: "latest" },
  { tool: "claude", channel: "latest" },
  { tool: "codex", channel: "latest" },
  { tool: "omp", channel: "latest" },
];

/** Exact versions and `major[.minor]` lines only; interpolated into mise specs and argv. */
export const VERSION_RE = /^[0-9A-Za-z._+-]{1,64}$/;
export const versionSchema = z.string().regex(VERSION_RE);

export const toolDefaultSchema = z.object({
  tool: curatedToolIdSchema,
  channel: z.enum(CHANNELS),
  pinnedVersion: versionSchema.nullish(),
});

export const toolchainDefaultsSchema = z.array(toolDefaultSchema).max(CATALOG.length);
export const toolchainDisabledSchema = z.array(curatedToolIdSchema);
