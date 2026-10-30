import { z } from "zod";
import { githubScopeString } from "./accounts.ts";

/**
 * Git hosting providers an AgentBox user can link for clone/pull/push (HTTPS + SSH): OAuth for the
 * big three, a pasted personal access token for self-hosted/other hosts.
 */

export const GIT_PROVIDER_IDS = [
  "github",
  "gitlab",
  "bitbucket",
  "gitlab-self",
  "gitea",
  "generic",
] as const;
export const gitProviderIdSchema = z.enum(GIT_PROVIDER_IDS);
export type GitProviderId = z.infer<typeof gitProviderIdSchema>;

export const GIT_OAUTH_PROVIDER_IDS = ["github", "gitlab", "bitbucket"] as const;
export type GitOAuthProviderId = (typeof GIT_OAUTH_PROVIDER_IDS)[number];
export function isGitOAuthProvider(s: string): s is GitOAuthProviderId {
  return (GIT_OAUTH_PROVIDER_IDS as readonly string[]).includes(s);
}

/** Providers a user adds with a pasted token (`addGitTokenAccount`). */
export const GIT_TOKEN_PROVIDER_IDS = ["gitlab", "gitlab-self", "gitea", "generic"] as const;
export type GitTokenProviderId = (typeof GIT_TOKEN_PROVIDER_IDS)[number];

export const GIT_METHODS = ["oauth", "token"] as const;
export type GitMethod = (typeof GIT_METHODS)[number];

export interface GitOAuthSpec {
  host: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Space separated; Bitbucket takes its scopes from the consumer, so none are sent. */
  scopes: string | null;
  /** Path under the app origin registered as the redirect URI (GitHub's two paths live in the web env). */
  callbackPath: string | null;
  apiBase: string;
  /** Env vars holding the OAuth client credentials (GitHub's are resolved by the web env). */
  clientIdEnv: string | null;
  clientSecretEnv: string | null;
  /** Access tokens expire and come with a refresh token. */
  refreshable: boolean;
}

export const GIT_OAUTH: Record<GitOAuthProviderId, GitOAuthSpec> = {
  github: {
    host: "github.com",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: null, // see gitOAuthScopes (workflow opt-in)
    callbackPath: null,
    apiBase: "https://api.github.com",
    clientIdEnv: null,
    clientSecretEnv: null,
    refreshable: false,
  },
  gitlab: {
    host: "gitlab.com",
    authorizeUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    scopes: "api read_user write_repository",
    callbackPath: "/api/git/gitlab/callback",
    apiBase: "https://gitlab.com/api/v4",
    clientIdEnv: "GITLAB_CLIENT_ID",
    clientSecretEnv: "GITLAB_CLIENT_SECRET",
    refreshable: true,
  },
  bitbucket: {
    host: "bitbucket.org",
    authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
    scopes: "account repository:write pullrequest",
    callbackPath: "/api/git/bitbucket/callback",
    apiBase: "https://api.bitbucket.org/2.0",
    clientIdEnv: "BITBUCKET_CLIENT_ID",
    clientSecretEnv: "BITBUCKET_CLIENT_SECRET",
    refreshable: true,
  },
};

export interface GitProviderInfo {
  id: GitProviderId;
  label: string;
  /** Fixed host, or null when the user enters it. */
  host: string | null;
}

export const GIT_PROVIDERS: Record<GitProviderId, GitProviderInfo> = {
  github: { id: "github", label: "GitHub", host: "github.com" },
  gitlab: { id: "gitlab", label: "GitLab", host: "gitlab.com" },
  bitbucket: { id: "bitbucket", label: "Bitbucket", host: "bitbucket.org" },
  "gitlab-self": { id: "gitlab-self", label: "GitLab (self-managed)", host: null },
  gitea: { id: "gitea", label: "Gitea / Forgejo", host: null },
  generic: { id: "generic", label: "Other Git host", host: null },
};

/** OAuth scope string for a provider; GitHub's `workflow` scope is an explicit opt-in. */
export function gitOAuthScopes(provider: GitOAuthProviderId, allowWorkflow = false): string | null {
  if (provider === "github") return githubScopeString(allowWorkflow);
  return GIT_OAUTH[provider].scopes;
}

/** Where the user creates a personal access token (or app password) on `host`. */
export function gitTokenPageUrl(provider: GitProviderId, host: string): string {
  switch (provider) {
    case "github":
      return "https://github.com/settings/tokens";
    case "gitlab":
    case "gitlab-self":
      return `https://${host}/-/user_settings/personal_access_tokens`;
    case "bitbucket":
      return "https://bitbucket.org/account/settings/app-passwords/";
    case "gitea":
      return `https://${host}/user/settings/applications`;
    case "generic":
      return host === "bitbucket.org"
        ? "https://bitbucket.org/account/settings/app-passwords/"
        : `https://${host}/`;
  }
}

/** Human description of what a pasted token needs. */
export function gitTokenScopesHint(provider: GitProviderId, host?: string): string {
  switch (provider) {
    case "github":
      return "repo, read:org, gist, write:public_key";
    case "gitlab":
    case "gitlab-self":
      return "api, read_user, write_repository (and read_repository)";
    case "bitbucket":
      return "Account: read; Repositories: write";
    case "gitea":
      return "write:repository, write:user (to add the SSH key)";
    case "generic":
      return host === "bitbucket.org"
        ? "Repositories: write (app password)"
        : "Whatever the host needs for git over HTTPS (clone, pull, push)";
  }
}

/** Username git presents with the stored token over HTTPS. */
export function gitCredentialUsername(input: {
  provider: GitProviderId;
  method: GitMethod;
  login: string;
}): string {
  if (input.method === "oauth") {
    if (input.provider === "gitlab") return "oauth2";
    if (input.provider === "bitbucket") return "x-token-auth";
  }
  return input.login;
}

/** The provider can add the workspace's SSH public key through its API with this connection. */
export function sshUploadSupported(provider: GitProviderId, method: GitMethod): boolean {
  if (provider === "github" || provider === "gitlab" || provider === "gitea") return true;
  if (provider === "bitbucket") return method === "oauth";
  if (provider === "gitlab-self") return true;
  return false;
}

/** The GitHub OAuth token can upload SSH keys. */
export function githubCanUploadKeys(scopes: string | null | undefined): boolean {
  return (scopes ?? "")
    .split(/[\s,]+/)
    .some((s) => s === "write:public_key" || s === "admin:public_key");
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".localdomain",
  ".test",
];

/**
 * Bare, lowercase hostname for a self-hosted git server, or null: https only (no scheme/port/path),
 * at least two labels, not an IP literal, not localhost / a local-only suffix.
 */
export function normalizeGitHost(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.length < 4 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return null;
  // IPv4 literals (and any all-numeric TLD) are never valid hostnames here.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return host;
}

/** Official SSH host keys (github.com meta API, GitLab docs, bitbucket.org/site/ssh) and their SHA256 fingerprints. */
export const PINNED_SSH_HOST_KEYS: Record<string, readonly string[]> = {
  "github.com": [
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  ],
  "gitlab.com": [
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9",
  ],
  "bitbucket.org": [
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
  ],
};

export const PINNED_SSH_FINGERPRINTS: Record<string, readonly string[]> = {
  "github.com": [
    "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  ],
  "gitlab.com": [
    "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8",
    "SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw",
    "SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ",
  ],
  "bitbucket.org": [
    "SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM",
    "SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0",
    "SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E",
  ],
};

/** known_hosts lines (`host type key`) for a pinned host, or null for hosts we ship no keys for. */
export function pinnedKnownHosts(host: string): string | null {
  const keys = PINNED_SSH_HOST_KEYS[host];
  return keys ? keys.map((k) => `${host} ${k}`).join("\n") : null;
}

/** Strict one-line-per-key known_hosts text for a host: pinned keys, else the stored scan result. */
export function knownHostsFor(host: string, scanned: string | null | undefined): string | null {
  return pinnedKnownHosts(host) ?? (scanned && scanned.trim() ? scanned.trim() : null);
}
