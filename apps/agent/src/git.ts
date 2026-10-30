import type { GitConnectionSpec, PutGitRequest, PutGitResponse } from "@agentbox/core/agent-api";
import { knownHostsFor, normalizeGitHost } from "@agentbox/core/git";
import { ghDisconnect, type ContainerExec } from "./accounts.ts";
import { HttpError } from "./errors.ts";
import { isPlainArg } from "./safe.ts";

/**
 * Git account state inside a workspace container, reconciled from the full desired state:
 * SSH key, ssh config + known_hosts managed blocks, HTTPS credential store, `gh` login, identity.
 * Scripts are static; request values only travel as argv or stdin after validation.
 */

export const SSH_KEY_PATH = ".ssh/agentbox_ed25519";
export const SSH_CONFIG_PATH = ".ssh/config";
export const KNOWN_HOSTS_PATH = ".ssh/known_hosts";
export const CREDENTIALS_PATH = ".agentbox/git-credentials";
export const BLOCK_START = "# >>> agentbox";
export const BLOCK_END = "# <<< agentbox";

const GITHUB_HOST = "github.com";
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+( .*)?$/;
const HELPER_PATTERN = "^store --file .*agentbox/git-credentials$";

const bash = (script: string, ...args: string[]): string[] => [
  "bash",
  "-c",
  `[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh; ${script}`,
  "_",
  ...args,
];

/** Create the workspace key once (kept across restarts and keep-data recreates); print its public half. */
const ENSURE_SSH_KEY = bash(
  [
    'k="$HOME/.ssh/agentbox_ed25519"; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh";',
    '[ -f "$k" ] || ssh-keygen -q -t ed25519 -N "" -C "$1" -f "$k" >/dev/null || exit 1;',
    '[ -s "$k.pub" ] || { echo "$(ssh-keygen -y -f "$k") $1" > "$k.pub"; };',
    'cat "$k.pub"',
  ].join(" "),
);

/** Atomic private write of `$HOME/$1` (content on stdin), parent directory 0700. */
const WRITE_HOME_FILE = bash(
  [
    'p="$HOME/$1"; d="$(dirname "$p")"; mkdir -p "$d"; chmod 700 "$d"; umask 077;',
    't="$p.$$"; cat > "$t" && chmod 600 "$t" && mv -f "$t" "$p"',
  ].join(" "),
);

const READ_HOME_FILE = bash('cat "$HOME/$1" 2>/dev/null; true');

export function validateGitRequest(req: PutGitRequest): void {
  const seen = new Set<string>();
  for (const c of req.connections) {
    if (normalizeGitHost(c.host) !== c.host) throw new HttpError(400, `invalid host ${c.host}`);
    if (seen.has(c.host)) throw new HttpError(400, `duplicate host ${c.host}`);
    seen.add(c.host);
    if (/[\r\n\0]/.test(c.token)) throw new HttpError(400, "invalid token");
    if (!isPlainArg(c.login) || !isPlainArg(c.username))
      throw new HttpError(400, "invalid login or username");
    if (c.knownHosts !== undefined) checkKnownHosts(c.host, c.knownHosts);
  }
  if (req.identity && (!isPlainArg(req.identity.name) || !isPlainArg(req.identity.email))) {
    throw new HttpError(400, "invalid identity");
  }
}

/** Stored scan results are user-influenced: only key lines for this very host may reach known_hosts. */
function checkKnownHosts(host: string, text: string): void {
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const [name, ...rest] = l.split(" ");
    if (name !== host || !KEY_LINE.test(rest.join(" "))) {
      throw new HttpError(400, `invalid known_hosts for ${host}`);
    }
  }
}

/** Connections whose HTTPS access goes through the credential store (GitHub uses `gh`). */
const storeConnections = (conns: readonly GitConnectionSpec[]) =>
  conns.filter((c) => !(c.provider === "github" && c.host === GITHUB_HOST));

/** `git credential-store` lines: `https://<user>:<token>@<host>`, percent-encoded. */
export function renderCredentialStore(conns: readonly GitConnectionSpec[]): string {
  return storeConnections(conns)
    .map(
      (c) => `https://${encodeURIComponent(c.username)}:${encodeURIComponent(c.token)}@${c.host}\n`,
    )
    .join("");
}

/** The `~/.ssh/config` managed block body (without markers), or null with no connections. */
export function renderSshConfigBlock(conns: readonly GitConnectionSpec[]): string | null {
  if (conns.length === 0) return null;
  return conns
    .map((c) => {
      const lines = [
        `Host ${c.host}`,
        `  HostName ${c.host}`,
        "  User git",
        `  IdentityFile ~/${SSH_KEY_PATH}`,
        "  IdentitiesOnly yes",
      ];
      // No shipped or scanned keys: trust on first use rather than failing every clone.
      if (!knownHostsFor(c.host, c.knownHosts)) lines.push("  StrictHostKeyChecking accept-new");
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The `~/.ssh/known_hosts` managed block body: pinned keys for known hosts, stored scans otherwise. */
export function renderKnownHostsBlock(conns: readonly GitConnectionSpec[]): string | null {
  const blocks = conns
    .map((c) => knownHostsFor(c.host, c.knownHosts))
    .filter((t): t is string => t !== null);
  return blocks.length ? blocks.join("\n") : null;
}

/**
 * Replace (or add, or with `body === null` remove) the managed block, leaving everything the user
 * wrote untouched. An unterminated start marker is treated as the block running to the end of file.
 */
export function mergeManagedBlock(existing: string, body: string | null): string {
  const lines = existing.split("\n");
  const start = lines.findIndex((l) => l.trim() === BLOCK_START);
  let before = lines;
  let after: string[] = [];
  if (start >= 0) {
    const endRel = lines.slice(start + 1).findIndex((l) => l.trim() === BLOCK_END);
    before = lines.slice(0, start);
    after = endRel >= 0 ? lines.slice(start + 1 + endRel + 1) : [];
  }
  const trim = (ls: string[]) => {
    const out = [...ls];
    while (out.length && out[out.length - 1]!.trim() === "") out.pop();
    return out;
  };
  const head = trim(before);
  const tail = after.join("\n").replace(/^\n+/, "");
  const parts: string[] = [];
  if (head.length) parts.push(head.join("\n"));
  if (body !== null) parts.push(`${BLOCK_START}\n${body}\n${BLOCK_END}`);
  if (tail.trim()) parts.push(tail.replace(/\n+$/, ""));
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

async function syncManagedBlock(
  exec: ContainerExec,
  rel: string,
  body: string | null,
): Promise<void> {
  const cur = await exec([...READ_HOME_FILE, rel], { check: false });
  const next = mergeManagedBlock(cur.code === 0 ? cur.stdout : "", body);
  if (next === cur.stdout) return;
  await exec([...WRITE_HOME_FILE, rel], { input: next });
}

export async function ensureSshKey(exec: ContainerExec, ws: string): Promise<string> {
  const r = await exec([...ENSURE_SSH_KEY, `agentbox:${ws}`]);
  const key = r.stdout.trim().split("\n")[0] ?? "";
  if (!KEY_LINE.test(key)) throw new HttpError(500, "could not read the workspace SSH public key");
  return key;
}

const helperValue = (home: string) => `store --file ${home}/${CREDENTIALS_PATH}`;

/** Hosts (`https://host`) that currently route to our credential store. */
async function storedHelperHosts(exec: ContainerExec): Promise<string[]> {
  const r = await exec(
    ["git", "config", "--global", "--get-regexp", "^credential\\..*\\.helper$"],
    {
      check: false,
    },
  );
  if (r.code !== 0) return [];
  const hosts: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^credential\.(https:\/\/[^\s]+)\.helper (.*)$/.exec(line.trim());
    if (m && new RegExp(HELPER_PATTERN).test(m[2]!)) hosts.push(m[1]!);
  }
  return hosts;
}

async function syncCredentialStore(
  exec: ContainerExec,
  conns: readonly GitConnectionSpec[],
): Promise<void> {
  const home = (await exec(["printenv", "HOME"])).stdout.trim();
  if (!home.startsWith("/")) throw new HttpError(500, "workspace HOME is not set");
  const wanted = storeConnections(conns);
  await exec([...WRITE_HOME_FILE, CREDENTIALS_PATH], {
    input: renderCredentialStore(conns),
    redact: wanted.map((c) => c.token),
  });
  const wantedUrls = new Set(wanted.map((c) => `https://${c.host}`));
  for (const url of await storedHelperHosts(exec)) {
    if (!wantedUrls.has(url)) {
      await exec(
        ["git", "config", "--global", "--unset-all", `credential.${url}.helper`, HELPER_PATTERN],
        {
          check: false,
        },
      );
    }
  }
  for (const url of wantedUrls) {
    await exec([
      "git",
      "config",
      "--global",
      "--replace-all",
      `credential.${url}.helper`,
      helperValue(home),
      HELPER_PATTERN,
    ]);
  }
}

async function syncGithubCli(
  exec: ContainerExec,
  conns: readonly GitConnectionSpec[],
): Promise<void> {
  const gh = conns.find((c) => c.provider === "github" && c.host === GITHUB_HOST);
  if (!gh) {
    await ghDisconnect(exec);
    return;
  }
  await exec(["gh", "auth", "login", "--hostname", GITHUB_HOST, "--with-token"], {
    input: `${gh.token}\n`,
    redact: [gh.token],
  });
  await exec(["gh", "auth", "setup-git"], { redact: [gh.token] });
}

/** Set `user.name` / `user.email` only when unset. */
async function setIdentityIfUnset(
  exec: ContainerExec,
  identity: NonNullable<PutGitRequest["identity"]>,
): Promise<void> {
  for (const [key, value] of [
    ["user.name", identity.name],
    ["user.email", identity.email],
  ] as const) {
    const cur = await exec(["git", "config", "--global", "--get", key], { check: false });
    if (cur.code === 1 || (cur.code === 0 && cur.stdout.trim() === "")) {
      await exec(["git", "config", "--global", key, value]);
    } else if (cur.code !== 0) {
      throw new HttpError(500, `git config --get ${key} failed (${cur.code})`);
    }
  }
}

/** Make the workspace match `req` exactly; returns the workspace SSH public key. */
export async function reconcileGit(
  exec: ContainerExec,
  ws: string,
  req: PutGitRequest,
): Promise<PutGitResponse> {
  validateGitRequest(req);
  const sshPublicKey = await ensureSshKey(exec, ws);
  await syncCredentialStore(exec, req.connections);
  await syncManagedBlock(exec, SSH_CONFIG_PATH, renderSshConfigBlock(req.connections));
  await syncManagedBlock(exec, KNOWN_HOSTS_PATH, renderKnownHostsBlock(req.connections));
  await syncGithubCli(exec, req.connections);
  if (req.identity) await setIdentityIfUnset(exec, req.identity);
  return { sshPublicKey };
}
