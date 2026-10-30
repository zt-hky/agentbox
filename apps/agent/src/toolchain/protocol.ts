import {
  observedToolSchema,
  stepRecordSchema,
  toolchainResultSchema,
  type ObservedTool,
  type StepRecord,
  type ToolchainApplyRequest,
  type ToolchainResult,
  type ToolchainRunResponse,
  type ToolchainStateResponse,
} from "@agentbox/core/toolchain";
import { HttpError } from "../errors.ts";

/** Tenant HOME inside the workspace container (`--env HOME=/workspace/home`). */
export const CONTAINER_HOME = "/workspace/home";
export const RUNS_DIR = `${CONTAINER_HOME}/.agentbox/runs`;
export const LOGS_DIR = `${CONTAINER_HOME}/.agentbox/logs`;

/** An install is rejected when less than this is left of the tenant disk quota. */
export const MIN_FREE_QUOTA_BYTES = 700 * 1024 * 1024;
/** Upper bound of log bytes returned by one run poll. */
export const MAX_LOG_CHUNK = 256 * 1024;

export const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
export const scriptPath = (runId: string): string => `${runDir(runId)}/apply.sh`;
export const planPath = (runId: string): string => `${runDir(runId)}/plan.json`;
export const logPath = (runId: string): string => `${LOGS_DIR}/${runId}.log`;

/** `command -v mise` the way a toolchain run sees it (positional args: none). */
export const MISE_CHECK_SNIPPET =
  "[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh; command -v mise >/dev/null 2>&1";

/** Exit 1 when another run holds the lock; stdout is then the id of the active run (may be empty). */
export const BUSY_SNIPPET = `mkdir -p "$HOME/.agentbox" && { flock -n "$HOME/.agentbox/run.lock" true; rc=$?; [ $rc -eq 1 ] || exit $rc; for p in "$HOME"/.agentbox/runs/*/pid; do pid=$(cat "$p" 2>/dev/null); if [ -n "$pid" ] && grep -qa apply.sh "/proc/$pid/cmdline" 2>/dev/null; then basename "$(dirname "$p")"; break; fi; done; exit 1; }`;

/** Positional args: runId. Fresh run dir (mode 700), stale files of a reused id are dropped. */
export const PREPARE_SNIPPET =
  'umask 077; d="$HOME/.agentbox/runs/$1"; rm -rf "$d" && mkdir -p "$d" "$HOME/.agentbox/logs" && rm -f "$HOME/.agentbox/logs/$1.log"';

/** Positional args: script, run dir, log file. Starts the script as its own session leader. */
export const DETACH_SNIPPET = 'exec setsid bash "$1" "$2" >"$3" 2>&1 </dev/null';

/**
 * Positional args: runId, offset. Prints four lines: state, then base64 of the log chunk, steps.jsonl
 * and result.json (base64 keeps multi-byte text and newlines out of the framing).
 */
export const RUN_SNIPPET = `
d="$HOME/.agentbox/runs/$1"; l="$HOME/.agentbox/logs/$1.log"
if [ ! -d "$d" ]; then echo missing; exit 0; fi
pid=$(cat "$d/pid" 2>/dev/null)
if [ -f "$d/result.json" ]; then s=finished
elif [ -n "$pid" ] && grep -qa apply.sh "/proc/$pid/cmdline" 2>/dev/null; then s=running
elif [ -z "$pid" ] && [ -n "$(find "$d/plan.json" -mmin -1 2>/dev/null)" ]; then s=running
else s=interrupted; fi
echo "$s"
tail -c +$(($2 + 1)) "$l" 2>/dev/null | head -c ${MAX_LOG_CHUNK} | base64 -w0; echo
base64 -w0 "$d/steps.jsonl" 2>/dev/null; echo
base64 -w0 "$d/result.json" 2>/dev/null; echo
`;

/** Positional args: runId. Prints none | stopped | killed. */
export const CANCEL_SNIPPET = `
pid=$(cat "$HOME/.agentbox/runs/$1/pid" 2>/dev/null)
if [ -z "$pid" ] || ! grep -qa apply.sh "/proc/$pid/cmdline" 2>/dev/null; then echo none; exit 0; fi
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
i=0; while [ $i -lt 50 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  echo killed
else echo stopped; fi
`;

/** No positional args. Prints base64 of toolchain.json, base64 of versions.json, then 1/0 for mise. */
export const STATE_SNIPPET = `
base64 -w0 "$HOME/.agentbox/toolchain.json" 2>/dev/null; echo
base64 -w0 /opt/agentbox/versions.json 2>/dev/null; echo
[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh
if command -v mise >/dev/null 2>&1; then echo 1; else echo 0; fi
`;

export interface TenantQuota {
  diskUsedBytes: number;
  diskLimitBytes: number;
}

/** Returns the rejection message, or null when the run may start. A limit of 0 means no quota is set. */
export function quotaDecision(
  tenant: TenantQuota | undefined,
  req: Pick<ToolchainApplyRequest, "mode" | "steps">,
): string | null {
  if (req.mode !== "apply" || !req.steps.some((s) => s.action === "install")) return null;
  if (!tenant || tenant.diskLimitBytes <= 0) return null;
  const remaining = tenant.diskLimitBytes - tenant.diskUsedBytes;
  if (remaining >= MIN_FREE_QUOTA_BYTES) return null;
  const mb = Math.max(0, Math.floor(remaining / (1024 * 1024)));
  return `quota: ${mb} MB of workspace disk left, installing tools needs at least ${Math.floor(MIN_FREE_QUOTA_BYTES / (1024 * 1024))} MB`;
}

const decode = (b64: string): Buffer => Buffer.from(b64.trim(), "base64");

export function parseStepRecords(text: string): StepRecord[] {
  const out: StepRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const r = stepRecordSchema.safeParse(json);
    if (r.success) out.push(r.data);
  }
  return out;
}

function parseResult(text: string): ToolchainResult | null {
  if (text.trim() === "") return null;
  try {
    const r = toolchainResultSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Parse the output of RUN_SNIPPET. `offset` is the byte offset the caller asked for. */
export function parseRunOutput(stdout: string, offset: number): ToolchainRunResponse {
  const [state = "", logB64 = "", stepsB64 = "", resultB64 = ""] = stdout.split("\n");
  if (state === "missing") {
    return { state: "missing", log: "", nextOffset: offset, steps: [], result: null };
  }
  if (state !== "running" && state !== "finished" && state !== "interrupted") {
    throw new HttpError(500, "unexpected toolchain run state output");
  }
  let chunk = decode(logB64);
  // Never split a line (or a UTF-8 sequence): drop a trailing partial line unless the run is over.
  if (
    chunk.length > 0 &&
    chunk[chunk.length - 1] !== 0x0a &&
    (state === "running" || chunk.length >= MAX_LOG_CHUNK)
  ) {
    const cut = chunk.lastIndexOf(0x0a);
    if (cut >= 0) chunk = chunk.subarray(0, cut + 1);
    else if (chunk.length < MAX_LOG_CHUNK) chunk = chunk.subarray(0, 0);
  }
  const result = parseResult(decode(resultB64).toString("utf8"));
  return {
    state: state === "finished" && result === null ? "interrupted" : state,
    log: chunk.toString("utf8"),
    nextOffset: offset + chunk.length,
    steps: parseStepRecords(decode(stepsB64).toString("utf8")),
    result,
  };
}

/** Parse the output of STATE_SNIPPET. Invalid entries are dropped rather than failing the call. */
export function parseStateOutput(stdout: string): ToolchainStateResponse {
  const [stateB64 = "", versionsB64 = "", mise = ""] = stdout.split("\n");
  const tools: Record<string, ObservedTool> = {};
  try {
    const parsed = JSON.parse(decode(stateB64).toString("utf8")) as {
      tools?: Record<string, unknown>;
    };
    for (const [id, v] of Object.entries(parsed.tools ?? {})) {
      const r = observedToolSchema.safeParse(v);
      if (r.success) tools[id] = r.data;
    }
  } catch {
    /* no state file yet */
  }
  let toolchainAbi: string | null = null;
  let envVersion: number | null = null;
  try {
    const v = JSON.parse(decode(versionsB64).toString("utf8")) as Record<string, unknown>;
    if (typeof v["toolchainAbi"] === "string") toolchainAbi = v["toolchainAbi"];
    if (typeof v["envVersion"] === "number" && Number.isInteger(v["envVersion"]))
      envVersion = v["envVersion"];
  } catch {
    /* image without a manifest */
  }
  return { tools, image: { hasMise: mise.trim() === "1", toolchainAbi, envVersion } };
}
