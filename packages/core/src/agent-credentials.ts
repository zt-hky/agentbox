import type { ToolId } from "./toolchain/catalog.ts";

/**
 * Credentials a user may paste for an agent CLI. The value is stored encrypted per user and
 * environment variable name (an account-level key: agents that read the same variable share it) and
 * synced into each workspace as `~/.agentbox/secrets.env`, which `env.sh` sources.
 */
export interface AgentCredentialSpec {
  envVar: string;
  label: string;
  hint: string;
  placeholder: string;
}

const ANTHROPIC_KEY: AgentCredentialSpec = {
  envVar: "ANTHROPIC_API_KEY",
  label: "Anthropic API key",
  hint: "From console.anthropic.com. Billed per token.",
  placeholder: "sk-ant-api03-…",
};
const OPENAI_KEY: AgentCredentialSpec = {
  envVar: "OPENAI_API_KEY",
  label: "OpenAI API key",
  hint: "From platform.openai.com. Billed per token.",
  placeholder: "sk-…",
};

export const AGENT_CREDENTIALS: Partial<Record<ToolId, readonly AgentCredentialSpec[]>> = {
  claude: [
    ANTHROPIC_KEY,
    {
      envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      label: "Claude subscription token",
      hint: "Run `claude setup-token` on any machine and paste the token (uses your Claude plan).",
      placeholder: "sk-ant-oat01-…",
    },
  ],
  codex: [OPENAI_KEY],
  omp: [ANTHROPIC_KEY, OPENAI_KEY],
  pi: [ANTHROPIC_KEY, OPENAI_KEY],
  opencode: [ANTHROPIC_KEY, OPENAI_KEY],
  grok: [
    {
      envVar: "XAI_API_KEY",
      label: "xAI API key",
      hint: "From console.x.ai.",
      placeholder: "xai-…",
    },
  ],
};

export function credentialSpecs(agent: string): readonly AgentCredentialSpec[] {
  return AGENT_CREDENTIALS[agent as ToolId] ?? [];
}

export function findCredentialSpec(agent: string, envVar: string): AgentCredentialSpec | undefined {
  return credentialSpecs(agent).find((s) => s.envVar === envVar);
}

/** Every environment variable the platform accepts as an agent credential. */
export const AGENT_CREDENTIAL_ENV_VARS: readonly string[] = [
  ...new Set(Object.values(AGENT_CREDENTIALS).flatMap((l) => (l ?? []).map((s) => s.envVar))),
];

export const MAX_CREDENTIAL_LENGTH = 4096;

/** A pasted secret: trimmed, single line, no control characters. Returns null when unusable. */
export function normalizeCredentialValue(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0 || v.length > MAX_CREDENTIAL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(v)) return null;
  return v;
}

/** Display form that never reveals the secret: `sk-ant-…a1B2`. */
export function maskCredential(value: string): string {
  if (value.length <= 10) return "••••";
  return `${value.slice(0, Math.min(6, value.length - 8))}…${value.slice(-4)}`;
}

/** POSIX single-quote a value for a shell env file. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Contents of `~/.agentbox/secrets.env`, sourced by `env.sh`. */
export function renderSecretsEnv(keys: Readonly<Record<string, string>>): string {
  const lines = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  return `# Managed by AgentBox. Edit credentials in Settings.\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}
