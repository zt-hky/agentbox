import type {
  ToolchainApplyRequest,
  ToolchainRunResponse,
  ToolchainStateResponse,
} from "@agentbox/core/toolchain";
import { tenantUser, writeSecretFileArgv } from "../argv.ts";
import { CONTAINER_NAME } from "../config.ts";
import { HttpError } from "../errors.ts";
import { runAs, type RunOptions } from "../exec.ts";
import { logEvent } from "../log.ts";
import { isPlainArg } from "../safe.ts";
import { withLock } from "../state.ts";
import { tenantStats } from "../stats.ts";
import { requireTenant } from "../tenants.ts";
import { containerRunning } from "../workspaces.ts";
import applyScript from "./apply.sh";
import {
  BUSY_SNIPPET,
  CANCEL_SNIPPET,
  DETACH_SNIPPET,
  MISE_CHECK_SNIPPET,
  PREPARE_SNIPPET,
  RUN_SNIPPET,
  STATE_SNIPPET,
  logPath,
  parseRunOutput,
  parseStateOutput,
  planPath,
  quotaDecision,
  runDir,
  scriptPath,
  CONTAINER_HOME,
} from "./protocol.ts";

/** `podman exec` as the workspace user; the command is argv, input travels on stdin. */
export function execArgv(args: string[], opts: { detached?: boolean } = {}): string[] {
  return [
    "podman",
    "exec",
    ...(opts.detached ? ["-d"] : ["-i"]),
    "-u",
    "1000",
    "--workdir",
    CONTAINER_HOME,
    CONTAINER_NAME,
    ...args,
  ];
}

const exec = (ws: string, args: string[], opts: RunOptions & { detached?: boolean } = {}) =>
  runAs(tenantUser(ws), execArgv(args, opts), { timeoutMs: 60_000, ...opts });

const sh = (snippet: string, ...positional: string[]): string[] => [
  "sh",
  "-c",
  snippet,
  "sh",
  ...positional,
];

async function requireRunning(ws: string): Promise<void> {
  const tenant = await requireTenant(ws);
  if (!(await containerRunning(ws, tenant.uid)))
    throw new HttpError(409, `workspace ${ws} is not running`);
}

function requireRunId(runId: string): void {
  if (!isPlainArg(runId)) throw new HttpError(400, "invalid run id");
}

export async function toolchainApply(ws: string, req: ToolchainApplyRequest): Promise<void> {
  requireRunId(req.runId);
  return withLock(ws, async () => {
    const t0 = Date.now();
    await requireRunning(ws);

    const mise = await exec(ws, sh(MISE_CHECK_SNIPPET), { check: false });
    if (mise.code !== 0) throw new HttpError(422, "image has no mise");

    if (req.mode === "apply" && req.steps.some((s) => s.action === "install")) {
      const tenant = (await tenantStats()).find((t) => t.ws === ws);
      const rejection = quotaDecision(tenant, req);
      if (rejection) throw new HttpError(507, rejection);
    }

    const busy = await exec(ws, sh(BUSY_SNIPPET), { check: false });
    if (busy.code === 1)
      throw new HttpError(423, `toolchain run ${busy.stdout.trim() || "unknown"} is active`);
    if (busy.code !== 0)
      throw new HttpError(
        500,
        `toolchain lock check failed (${busy.code}): ${busy.stderr.trim().slice(0, 200)}`,
      );

    // Script and plan travel on stdin only, never argv.
    await exec(ws, sh(PREPARE_SNIPPET, req.runId));
    await exec(ws, writeSecretFileArgv(scriptPath(req.runId)), { input: applyScript });
    await exec(ws, writeSecretFileArgv(planPath(req.runId)), { input: JSON.stringify(req) });
    await exec(
      ws,
      [
        "bash",
        "-c",
        DETACH_SNIPPET,
        "abx",
        scriptPath(req.runId),
        runDir(req.runId),
        logPath(req.runId),
      ],
      { detached: true },
    );
    logEvent({
      ws,
      event: "toolchain_started",
      runId: req.runId,
      mode: req.mode,
      steps: req.steps.length,
      durationMs: Date.now() - t0,
    });
  });
}

export async function toolchainRun(
  ws: string,
  runId: string,
  offset: number,
): Promise<ToolchainRunResponse> {
  requireRunId(runId);
  await requireRunning(ws);
  const r = await exec(ws, sh(RUN_SNIPPET, runId, String(offset)), {
    maxBytes: 2 * 1024 * 1024,
  });
  return parseRunOutput(r.stdout, offset);
}

export async function toolchainState(ws: string): Promise<ToolchainStateResponse> {
  await requireRunning(ws);
  const r = await exec(ws, sh(STATE_SNIPPET));
  return parseStateOutput(r.stdout);
}

export async function toolchainCancel(ws: string, runId: string): Promise<void> {
  requireRunId(runId);
  await requireRunning(ws);
  const r = await exec(ws, sh(CANCEL_SNIPPET, runId), { timeoutMs: 30_000 });
  logEvent({ ws, event: "toolchain_cancelled", runId, outcome: r.stdout.trim() });
}
