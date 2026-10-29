import { stat } from "node:fs/promises";
import type {
  GithubConnectRequest,
  WorkspaceLogResponse,
  WorkspaceTopResponse,
  StartWorkspaceRequest,
  StartWorkspaceResponse,
} from "@agentbox/core/agent-api";
import {
  podmanRunArgv,
  rootfsPath,
  tenantHome,
  tenantUser,
  envFileContent,
  writeSecretFileArgv,
} from "./argv.ts";
import { CONTAINER_NAME, HEALTH_TIMEOUT_MS, STOP_TIMEOUT_SEC } from "./config.ts";
import { HttpError } from "./errors.ts";
import { runAs } from "./exec.ts";
import { logEvent } from "./log.ts";
import { mergeLogStreams, parsePodmanTime, parsePodmanTop } from "./diagnostics.ts";
import { ensurePodmanSocket } from "./monitor.ts";
import { isPlainArg, isSafeCgroupPath, slotOfUid } from "./safe.ts";
import { registry, withLock } from "./state.ts";
import { requireTenant, startUserManager, stopUserManager, userManagerUp } from "./tenants.ts";

export async function containerRunning(ws: string, uid: number): Promise<boolean> {
  if (!(await userManagerUp(uid))) return false;
  const r = await runAs(
    tenantUser(ws),
    ["podman", "ps", "--filter", `name=^${CONTAINER_NAME}$`, "--format", "{{.State}}"],
    { check: false, timeoutMs: 30_000 },
  );
  return r.code === 0 && r.stdout.trim() === "running";
}

export interface InspectInfo {
  cgroupPath: string;
  imageId: string | null;
  startedAt: string | null;
}

export async function inspectContainer(ws: string): Promise<InspectInfo> {
  const r = await runAs(
    tenantUser(ws),
    [
      "podman",
      "inspect",
      "--format",
      "{{.State.CgroupPath}}\t{{.Rootfs}}\t{{.State.StartedAt}}",
      CONTAINER_NAME,
    ],
    { timeoutMs: 30_000 },
  );
  const [cg = "", rootfs = "", started = ""] = r.stdout.trim().split("\t");
  if (!isSafeCgroupPath(cg)) throw new HttpError(500, "podman reported no usable cgroup path");
  const m = /\/([0-9a-f]{64})\/?$/.exec(rootfs);
  return {
    cgroupPath: cg,
    imageId: m ? (m[1] as string) : null,
    startedAt: parsePodmanTime(started),
  };
}

async function waitHealthy(ws: string, uid: number, slot: number): Promise<void> {
  const urls = [
    `http://127.0.0.1:${20000 + 2 * slot}/`,
    `http://127.0.0.1:${20001 + 2 * slot}/healthz`,
  ];
  const ok = new Set<string>();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let tick = 0;
  while (Date.now() < deadline) {
    await Promise.all(
      urls
        .filter((u) => !ok.has(u))
        .map(async (u) => {
          try {
            await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(2000) });
            ok.add(u);
          } catch {
            /* not up yet */
          }
        }),
    );
    if (ok.size === urls.length) return;
    if (++tick % 5 === 0 && !(await containerRunning(ws, uid))) {
      throw new HttpError(500, "workspace container exited during startup");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new HttpError(
    504,
    `workspace did not answer on both ports within ${HEALTH_TIMEOUT_MS / 1000}s`,
  );
}

export function startWorkspace(
  ws: string,
  req: StartWorkspaceRequest,
): Promise<StartWorkspaceResponse> {
  return withLock(ws, async () => {
    const t0 = Date.now();
    const tenant = await requireTenant(ws);
    if (slotOfUid(tenant.uid) !== req.slot) {
      throw new HttpError(409, `slot ${req.slot} does not match tenant uid ${tenant.uid}`);
    }
    const isDir = await stat(rootfsPath(req.imageId)).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) throw new HttpError(404, `rootfs for image ${req.imageId} not found`);
    let envFile: string;
    try {
      envFile = envFileContent(req.env);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "invalid env");
    }

    await startUserManager(tenant.uid);
    const user = tenantUser(ws);
    await runAs(user, writeSecretFileArgv(`${tenantHome(ws)}/t3.env`), { input: envFile });
    await runAs(
      user,
      podmanRunArgv({ ws, slot: req.slot, imageId: req.imageId, limits: req.limits }),
      { detached: true },
    );
    try {
      await waitHealthy(ws, tenant.uid, req.slot);
    } catch (e) {
      await runAs(user, ["podman", "rm", "-f", "-t", "5", CONTAINER_NAME], { check: false });
      logEvent({ ws, event: "start_failed", imageId: req.imageId, durationMs: Date.now() - t0 });
      throw e;
    }
    const info = await inspectContainer(ws);
    const startedAt = info.startedAt ?? new Date().toISOString();
    registry.set(ws, {
      ws,
      uid: tenant.uid,
      slot: req.slot,
      cgroupPath: info.cgroupPath,
      imageId: req.imageId,
      startedAt,
    });
    await ensurePodmanSocket(user);
    logEvent({ ws, event: "started", imageId: req.imageId, durationMs: Date.now() - t0 });
    return { cgroupPath: info.cgroupPath, startedAt };
  });
}

/** Graceful stop of the container and its user manager; also used by the SIGTERM path. */
export async function stopContainer(ws: string, uid: number): Promise<number | null> {
  const user = tenantUser(ws);
  let exitCode: number | null = null;
  if (await userManagerUp(uid)) {
    const stop = await runAs(
      user,
      ["podman", "stop", "-t", String(STOP_TIMEOUT_SEC), CONTAINER_NAME],
      { check: false, timeoutMs: (STOP_TIMEOUT_SEC + 30) * 1000 },
    );
    exitCode = stop.code;
    await runAs(user, ["podman", "rm", "-f", "-t", "5", CONTAINER_NAME], { check: false });
  }
  registry.delete(ws);
  await stopUserManager(uid).catch(() => undefined);
  return exitCode;
}

export function stopWorkspace(ws: string): Promise<void> {
  return withLock(ws, async () => {
    const t0 = Date.now();
    const tenant = await requireTenant(ws);
    const imageId = registry.get(ws)?.imageId ?? undefined;
    const exitCode = await stopContainer(ws, tenant.uid);
    logEvent({ ws, event: "stopped", imageId, exitCode, durationMs: Date.now() - t0 });
  });
}

async function requireRunning(ws: string): Promise<void> {
  const tenant = await requireTenant(ws);
  if (!(await containerRunning(ws, tenant.uid)))
    throw new HttpError(409, `workspace ${ws} is not running`);
}

const exec = (
  ws: string,
  args: string[],
  opts: { input?: string; redact?: string[]; check?: boolean } = {},
) =>
  runAs(tenantUser(ws), ["podman", "exec", "-i", "-u", "1000", CONTAINER_NAME, ...args], {
    timeoutMs: 60_000,
    ...opts,
  });

export function githubConnect(ws: string, req: GithubConnectRequest): Promise<void> {
  return withLock(ws, async () => {
    if (/[\r\n\0]/.test(req.token)) throw new HttpError(400, "invalid token");
    if (!isPlainArg(req.login) || !isPlainArg(req.email))
      throw new HttpError(400, "invalid login or email");
    await requireRunning(ws);
    const redact = [req.token];
    await exec(ws, ["gh", "auth", "login", "--hostname", "github.com", "--with-token"], {
      input: `${req.token}\n`,
      redact,
    });
    await exec(ws, ["gh", "auth", "setup-git"], { redact });
    for (const [key, value] of [
      ["user.name", req.login],
      ["user.email", req.email],
    ] as const) {
      const cur = await exec(ws, ["git", "config", "--global", "--get", key], { check: false });
      if (cur.code === 1 || (cur.code === 0 && cur.stdout.trim() === "")) {
        await exec(ws, ["git", "config", "--global", key, value]);
      } else if (cur.code !== 0) {
        throw new HttpError(500, `git config --get ${key} failed (${cur.code})`);
      }
    }
    logEvent({ ws, event: "github_connected" });
  });
}

export function githubDisconnect(ws: string): Promise<void> {
  return withLock(ws, async () => {
    await requireRunning(ws);
    const r = await exec(ws, ["gh", "auth", "logout", "--hostname", "github.com"], {
      check: false,
    });
    if (r.code !== 0 && !/not logged in|no accounts|not logged/i.test(r.stderr)) {
      throw new HttpError(
        500,
        `gh auth logout failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`,
      );
    }
    logEvent({ ws, event: "github_disconnected" });
  });
}

const MAX_LOG_BYTES = 512 * 1024;

/** `podman logs` of the workspace container, as the tenant (diagnostics; never cached). */
export async function workspaceLogs(ws: string, tail: number): Promise<WorkspaceLogResponse> {
  await requireRunning(ws);
  const r = await runAs(
    tenantUser(ws),
    ["podman", "logs", "-t", "--tail", String(tail), CONTAINER_NAME],
    { timeoutMs: 30_000, maxBytes: 32 * 1024 * 1024 },
  );
  const log = mergeLogStreams(r.stdout, r.stderr, tail);
  return { log: log.length > MAX_LOG_BYTES ? log.slice(-MAX_LOG_BYTES) : log };
}

/** `podman top` of the workspace container, as the tenant. */
export async function workspaceTop(ws: string): Promise<WorkspaceTopResponse> {
  await requireRunning(ws);
  const user = tenantUser(ws);
  const [top, info] = await Promise.all([
    runAs(user, ["podman", "top", CONTAINER_NAME, "-eo", "pid,user,pcpu,pmem,etime,args"], {
      timeoutMs: 30_000,
    }),
    inspectContainer(ws),
  ]);
  return { startedAt: info.startedAt, processes: parsePodmanTop(top.stdout) };
}
