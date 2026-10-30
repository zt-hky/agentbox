import { GIT_OAUTH } from "@agentbox/core/git";
import type { OAuthClient } from "@agentbox/core/git-api";
import type { LogLevel } from "./log.ts";

export interface Config {
  baseDomain: string;
  appOrigin: string;
  port: number;
  agentSocket: string;
  agentToken: string;
  encryptionKey: string;
  /** OAuth clients used to refresh GitLab / Bitbucket tokens; absent when the admin did not configure them. */
  gitOAuth: Partial<Record<"gitlab" | "bitbucket", OAuthClient>>;
  logLevel: LogLevel;
}

function oauthClient(env: NodeJS.ProcessEnv, provider: "gitlab" | "bitbucket"): OAuthClient | null {
  const spec = GIT_OAUTH[provider];
  const clientId = spec.clientIdEnv ? env[spec.clientIdEnv] : undefined;
  const clientSecret = spec.clientSecretEnv ? env[spec.clientSecretEnv] : undefined;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  required(env, "DATABASE_URL");
  const encryptionKey = required(env, "AGENTBOX_ENCRYPTION_KEY");
  if (Buffer.from(encryptionKey, "base64").length !== 32) {
    throw new Error("AGENTBOX_ENCRYPTION_KEY must be base64 of 32 bytes");
  }
  const baseDomain = (env.AGENTBOX_BASE_DOMAIN || "agentbox.io.vn").toLowerCase();
  const level = env.AGENTBOX_LOG_LEVEL || "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new Error(`invalid AGENTBOX_LOG_LEVEL: ${level}`);
  }
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid PORT");
  const gitOAuth: Config["gitOAuth"] = {};
  for (const provider of ["gitlab", "bitbucket"] as const) {
    const client = oauthClient(env, provider);
    if (client) gitOAuth[provider] = client;
  }
  return {
    baseDomain,
    appOrigin: `https://app.${baseDomain}`,
    port,
    agentSocket: env.AGENTBOX_AGENT_SOCKET || "/run/agentbox/agent.sock",
    agentToken: required(env, "AGENTBOX_AGENT_TOKEN"),
    encryptionKey,
    gitOAuth,
    logLevel: level as LogLevel,
  };
}
