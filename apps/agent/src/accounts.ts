import { z } from "zod";
import {
  COPILOT_DEVICE_CODE_TTL_S,
  COPILOT_DEVICE_URL,
  type CopilotLoginState,
} from "@agentbox/core/accounts";
import { renderSecretsEnv } from "@agentbox/core/agent-credentials";
import { HttpError } from "./errors.ts";
import type { RunResult } from "./exec.ts";
import { lastLines } from "./safe.ts";

/**
 * GitHub/Copilot account state inside a workspace container. Everything here is a static script or
 * argv (never an interpolated DB string); the only external data is parsed back out of CLI output.
 */

export type ContainerExec = (
  args: string[],
  opts?: { input?: string; check?: boolean; redact?: string[] },
) => Promise<RunResult>;

// Static scripts run by `bash -c`. `$HOME` is /workspace/home; env.sh (image-owned) puts the
// toolchain farm on PATH and does not exist on older images.
const PRELUDE =
  '[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh; d="$HOME/.agentbox/copilot-login";';
const bash = (script: string): string[] => ["bash", "-c", `${PRELUDE} ${script}`];

const COPILOT_CHECK = bash("command -v copilot >/dev/null 2>&1");

/** Detached device-code login; stdout+stderr -> log, exit code -> `exit`, copilot's pid -> `cpid`. */
const COPILOT_LOGIN_START = bash(
  [
    'rm -rf "$d"; mkdir -p "$d"; chmod 700 "$d"; date +%s > "$d/started";',
    '( copilot login --device-code > "$d/log" 2>&1 < /dev/null & echo $! > "$d/cpid";',
    'wait $!; echo $? > "$d/exit" ) > /dev/null 2>&1 &',
  ].join(" "),
);

const COPILOT_LOGIN_SNAPSHOT = bash(
  [
    '[ -d "$d" ] || { echo none; exit 0; };',
    'echo "started=$(cat "$d/started" 2>/dev/null)";',
    'echo "exit=$(cat "$d/exit" 2>/dev/null)";',
    '[ -e "$d/cancelled" ] && echo cancelled=1 || echo cancelled=0;',
    'if [ -s "$d/cpid" ] && kill -0 "$(cat "$d/cpid")" 2>/dev/null; then echo alive=1; else echo alive=0; fi;',
    'echo "---log"; head -c 8192 "$d/log" 2>/dev/null; true',
  ].join(" "),
);

const COPILOT_LOGIN_CANCEL = bash(
  [
    '[ -d "$d" ] || exit 0; : > "$d/cancelled";',
    '[ -s "$d/cpid" ] && kill "$(cat "$d/cpid")" 2>/dev/null; true',
  ].join(" "),
);

/** Copilot's plaintext login (no keychain in a container) lives in config.json; sessions stay. */
const COPILOT_REMOVE_LOGIN = bash(
  'rm -rf "$d"; rm -f "$HOME/.copilot/config.json"; ! test -e "$HOME/.copilot/config.json"',
);

const T3_SETTINGS = '"$HOME/.t3/userdata/settings.json"';
const READ_T3_SETTINGS = bash(`cat ${T3_SETTINGS} 2>/dev/null; true`);
const WRITE_T3_SETTINGS = bash(
  `f=${T3_SETTINGS}; mkdir -p "\${f%/*}"; t="$f.agentbox.$$"; cat > "$t" && mv -f "$t" "$f"`,
);

// ---- Copilot device-login state machine -------------------------------------------------------

const CODE_RE = /enter code ([A-Z0-9]{3,6}-[A-Z0-9]{3,6})\b/;
const VISIT_RE = /visit (\S+) and enter code/;

interface Snapshot {
  none: boolean;
  startedAt: number | null;
  exitCode: number | null;
  cancelled: boolean;
  alive: boolean;
  log: string;
}

export function parseLoginSnapshot(text: string): Snapshot {
  const idx = text.indexOf("---log\n");
  const head = idx < 0 ? text : text.slice(0, idx);
  const log = idx < 0 ? "" : text.slice(idx + "---log\n".length);
  const kv = new Map<string, string>();
  for (const line of head.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const int = (k: string): number | null => {
    const v = kv.get(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
  };
  return {
    none: head.trim() === "none" || (!kv.has("started") && !kv.has("exit")),
    startedAt: int("started"),
    exitCode: int("exit"),
    cancelled: kv.get("cancelled") === "1",
    alive: kv.get("alive") === "1",
    log,
  };
}

const state = (
  status: CopilotLoginState["status"],
  extra: Partial<Omit<CopilotLoginState, "status">> = {},
): CopilotLoginState => ({
  status,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  error: null,
  ...extra,
});

/** Pure derivation of the login state from what the container reports. */
export function deriveCopilotLogin(snap: Snapshot, nowSec: number): CopilotLoginState {
  if (snap.none) return state("idle");
  if (snap.cancelled) return state("cancelled");
  if (snap.exitCode === 0) return state("signed_in");
  const code = CODE_RE.exec(snap.log)?.[1] ?? null;
  const visit = VISIT_RE.exec(snap.log)?.[1] ?? null;
  const expiresAt =
    snap.startedAt === null
      ? null
      : new Date((snap.startedAt + COPILOT_DEVICE_CODE_TTL_S) * 1000).toISOString();
  if (snap.exitCode !== null) {
    const tail = lastLines(snap.log.trim(), 1).slice(0, 300);
    if (/expired|timed? ?out/i.test(snap.log)) return state("expired");
    return state("failed", { error: tail || `copilot login exited with code ${snap.exitCode}` });
  }
  if (snap.startedAt !== null && nowSec >= snap.startedAt + COPILOT_DEVICE_CODE_TTL_S)
    return state("expired");
  if (!snap.alive) {
    // The exit file is written a moment after the process ends; give it a few seconds.
    if (snap.startedAt !== null && nowSec - snap.startedAt < 5) return state("starting");
    return state("failed", { error: "copilot login ended without a result" });
  }
  if (code === null) return state("starting", { expiresAt });
  if (visit !== null && visit !== COPILOT_DEVICE_URL)
    return state("failed", { error: "copilot login pointed at an unexpected URL" });
  return state("code", { userCode: code, verificationUri: COPILOT_DEVICE_URL, expiresAt });
}

export async function copilotLoginStart(
  exec: ContainerExec,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<CopilotLoginState> {
  const installed = await exec(COPILOT_CHECK, { check: false });
  if (installed.code !== 0)
    throw new HttpError(409, "the copilot CLI is not installed in this workspace");
  // A live session with an unexpired code is reused: restarting would invalidate the shown code.
  const cur = await copilotLoginState(exec, nowSec);
  if (cur.status === "starting" || cur.status === "code") return cur;
  await exec(COPILOT_LOGIN_START);
  return copilotLoginState(exec, nowSec);
}

export async function copilotLoginState(
  exec: ContainerExec,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<CopilotLoginState> {
  const r = await exec(COPILOT_LOGIN_SNAPSHOT);
  const snap = parseLoginSnapshot(r.stdout);
  const derived = deriveCopilotLogin(snap, nowSec());
  // An expired code leaves a process waiting on GitHub; stop it.
  if (derived.status === "expired" && snap.exitCode === null && snap.alive)
    await exec(COPILOT_LOGIN_CANCEL, { check: false });
  return derived;
}

export async function copilotLoginCancel(exec: ContainerExec): Promise<void> {
  await exec(COPILOT_LOGIN_CANCEL, { check: false });
}

// ---- T3 settings: Copilot provider instance ---------------------------------------------------

export const T3_COPILOT_INSTANCE_ID = "copilot";

/** `copilot --acp` as a local ACP command; the `copilot` basename turns on T3's Copilot routing. */
export const T3_COPILOT_INSTANCE = {
  driver: "acpRegistry",
  displayName: "GitHub Copilot",
  config: { source: "local", commandPath: "copilot", commandArgs: ["--acp"] },
} as const;

const settingsSchema = z.looseObject({
  providerInstances: z.record(z.string(), z.unknown()).optional(),
});

const ourInstanceSchema = z.looseObject({
  driver: z.literal("acpRegistry"),
  config: z.looseObject({
    source: z.literal("local"),
    commandPath: z.literal("copilot"),
    commandArgs: z.tuple([z.literal("--acp")]),
  }),
});

/**
 * Seed (enabled) or remove (disabled) the Copilot provider instance. Never overwrites an existing
 * `copilot` instance the user edited, never removes one that is not exactly ours, and leaves
 * every other key untouched. `changed=false` means the file must not be rewritten.
 */
export function mergeCopilotProvider(
  text: string | null,
  enabled: boolean,
): { text: string; changed: boolean } {
  const trimmed = (text ?? "").trim();
  let json: unknown = {};
  if (trimmed !== "") {
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new HttpError(409, "T3 settings.json is not valid JSON; left untouched");
    }
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success)
    throw new HttpError(409, "T3 settings.json has an unexpected shape; left untouched");
  // Mutate the original object (not zod's copy) so unknown keys keep their order.
  const root = json as z.infer<typeof settingsSchema>;
  const instances = parsed.data.providerInstances ?? {};
  const has = Object.hasOwn(instances, T3_COPILOT_INSTANCE_ID);
  const unchanged = { text: text ?? "", changed: false };
  if (enabled) {
    if (has) return unchanged;
    root.providerInstances = { ...instances, [T3_COPILOT_INSTANCE_ID]: T3_COPILOT_INSTANCE };
  } else {
    if (!has || !ourInstanceSchema.safeParse(instances[T3_COPILOT_INSTANCE_ID]).success)
      return unchanged;
    const rest = { ...instances };
    delete rest[T3_COPILOT_INSTANCE_ID];
    root.providerInstances = rest;
  }
  return { text: `${JSON.stringify(root, null, 2)}\n`, changed: true };
}

export async function setCopilotProvider(exec: ContainerExec, enabled: boolean): Promise<void> {
  const cur = await exec(READ_T3_SETTINGS);
  const next = mergeCopilotProvider(cur.stdout === "" ? null : cur.stdout, enabled);
  if (!next.changed) return;
  await exec(WRITE_T3_SETTINGS, { input: next.text });
}

// ---- Sign-out / disconnect reverse state ------------------------------------------------------

/** Copilot sign-out: stop any login session, delete the stored login, drop the T3 provider. */
export async function copilotLogout(exec: ContainerExec): Promise<void> {
  await copilotLoginCancel(exec);
  const r = await exec(COPILOT_REMOVE_LOGIN, { check: false });
  if (r.code !== 0) throw new HttpError(500, "could not remove the copilot login from ~/.copilot");
  await setCopilotProvider(exec, false);
}

const GH_HELPER_RE = /^!.*\bgh auth git-credential$/;
const CREDENTIAL_HOSTS = ["https://github.com", "https://gist.github.com"] as const;

/**
 * `gh auth setup-git` writes `helper =` (empty reset) + `!gh auth git-credential` under each of
 * these host sections. Remove a section only if every helper in it is one of those; a section the
 * user added their own helper to stays.
 */
export async function removeGhCredentialHelpers(exec: ContainerExec): Promise<string[]> {
  const removed: string[] = [];
  for (const host of CREDENTIAL_HOSTS) {
    const section = `credential.${host}`;
    const got = await exec(["git", "config", "--global", "--get-all", `${section}.helper`], {
      check: false,
    });
    if (got.code !== 0) continue;
    const helpers = got.stdout.split("\n").filter((l) => l.trim() !== "");
    if (helpers.length === 0 || !helpers.every((h) => GH_HELPER_RE.test(h.trim()))) continue;
    await exec(["git", "config", "--global", "--remove-section", section], { check: false });
    removed.push(host);
  }
  return removed;
}

/** `gh auth logout` + credential helper removal. Copilot has its own sign-out. */
export async function ghDisconnect(exec: ContainerExec): Promise<void> {
  const r = await exec(["gh", "auth", "logout", "--hostname", "github.com"], { check: false });
  if (r.code !== 0 && !/not logged in|no accounts|not logged/i.test(r.stderr)) {
    throw new HttpError(500, `gh auth logout failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  await removeGhCredentialHelpers(exec);
}

/** Atomic 0600 write of `~/.agentbox/secrets.env` (sourced by env.sh); the value arrives on stdin. */
const WRITE_SECRETS_ENV = bash(
  [
    'd="$HOME/.agentbox"; mkdir -p "$d"; chmod 700 "$d"; umask 077;',
    't="$d/secrets.env.$$"; cat > "$t" && chmod 600 "$t" && mv -f "$t" "$d/secrets.env"',
  ].join(" "),
);

/** Replace the workspace's agent credentials with `keys` (env var -> value); `{}` clears them. */
export async function writeAgentKeys(
  exec: ContainerExec,
  keys: Readonly<Record<string, string>>,
): Promise<void> {
  await exec(WRITE_SECRETS_ENV, { input: renderSecretsEnv(keys), redact: Object.values(keys) });
}
