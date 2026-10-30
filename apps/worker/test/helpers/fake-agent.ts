import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ObservedTool,
  StepRecord,
  ToolchainApplyRequest,
  ToolchainRunResponse,
} from "@agentbox/core/toolchain";

export interface FakeCall {
  method: string;
  path: string;
  query: string;
  body: unknown;
  auth: string | undefined;
}
export type Reply = { status?: number; json?: unknown } | "hang";
export type RouteFn = (call: FakeCall) => Reply | Promise<Reply>;

export const TOKEN = "test-agent-token";
export const IMAGE_ID = "a".repeat(64);
/** The public key the fake agent reports for every workspace. */
export const WORKSPACE_SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWorkspaceKeyFakeWorkspaceKeyFake0000 agentbox:alice";

/** What the fake agent reports for one toolchain run. */
export interface ToolchainScriptReply {
  /** HTTP status for the apply call (409 / 422 / 507 simulate the agent refusing the run). */
  applyStatus?: number;
  applyError?: string;
  /** Run state reported by `GET .../runs/:id` (default `finished`; `running` never ends). */
  state?: ToolchainRunResponse["state"];
  log?: string;
  steps?: StepRecord[];
  /** Overrides the observed tools in the final result (default: derived from ok steps). */
  tools?: Record<string, ObservedTool>;
}
export type ToolchainScript = (
  req: ToolchainApplyRequest,
) => ToolchainScriptReply | Promise<ToolchainScriptReply>;

/** Default script: every step succeeds with its requested version. */
export const okToolchainScript: ToolchainScript = (req) => ({
  log: `run ${req.runId} (${req.mode})\n`,
  steps: req.steps.map((s) => ({
    tool: s.tool,
    action: s.action,
    status: "ok" as const,
    version: s.version,
    previous: null,
    backend: s.backends[0]?.spec ?? null,
    sizeBytes: 1000,
    observed: s.action === "verify" ? `${s.tool} 1.0.0` : null,
    path: s.action === "verify" ? `/usr/bin/${s.tool}` : null,
  })),
});

export interface FakeAgent {
  socketPath: string;
  /** Script the toolchain routes; `calls` lists every apply request in `applies`. */
  toolchain: { script: ToolchainScript; applies: ToolchainApplyRequest[]; cancelled: string[] };
  /** Toolchain state returned by `GET .../toolchain/state`. */
  toolchainState: { hasMise: boolean; toolchainAbi: string | null };
  calls: FakeCall[];
  /** Override the reply for `METHOD /path` (exact path, no query). */
  on(route: string, fn: RouteFn | Reply): void;
  callsTo(route: string): FakeCall[];
  close(): Promise<void>;
}

function defaultReply(method: string, path: string): Reply {
  if (method === "POST" && /^\/v1\/workspaces\/[^/]+\/start$/.test(path)) {
    return { json: { cgroupPath: "user.slice/x", startedAt: new Date().toISOString() } };
  }
  if (method === "POST" && path === "/v1/images/build") {
    return {
      json: {
        imageId: IMAGE_ID,
        scanSummary: {
          counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 0 },
          fixableCritical: 0,
        },
        logPath: "/var/lib/agentbox-build/logs/x.log",
      },
    };
  }
  if (method === "GET" && /^\/v1\/images\/build\/[^/]+\/log$/.test(path)) {
    return { json: { log: "step 1\nstep 2" } };
  }
  if (method === "PUT" && /^\/v1\/workspaces\/[^/]+\/git$/.test(path)) {
    return { json: { sshPublicKey: WORKSPACE_SSH_KEY } };
  }
  return { json: { ok: true } };
}

export async function startFakeAgent(): Promise<FakeAgent> {
  const dir = mkdtempSync(join(tmpdir(), "abx-fake-agent-"));
  const socketPath = join(dir, "agent.sock");
  const calls: FakeCall[] = [];
  const routes = new Map<string, RouteFn | Reply>();
  const sockets = new Set<import("node:net").Socket>();
  const toolchain: FakeAgent["toolchain"] = {
    script: okToolchainScript,
    applies: [],
    cancelled: [],
  };
  const toolchainState: FakeAgent["toolchainState"] = {
    hasMise: true,
    toolchainAbi: "ubuntu-26.04",
  };
  const toolchainRuns = new Map<
    string,
    { req: ToolchainApplyRequest; reply: ToolchainScriptReply }
  >();

  async function toolchainReply(call: FakeCall): Promise<Reply | null> {
    const base = /^\/v1\/workspaces\/[^/]+\/toolchain/;
    if (!base.test(call.path)) return null;
    if (call.method === "POST" && call.path.endsWith("/toolchain/apply")) {
      const req = call.body as ToolchainApplyRequest;
      const reply = await toolchain.script(req);
      toolchain.applies.push(req);
      if (reply.applyStatus) {
        return { status: reply.applyStatus, json: { error: reply.applyError ?? "refused" } };
      }
      toolchainRuns.set(req.runId, { req, reply });
      return { json: { ok: true } };
    }
    if (call.method === "POST" && call.path.endsWith("/cancel")) {
      toolchain.cancelled.push(call.path.split("/").at(-2) ?? "");
      return { json: { ok: true } };
    }
    if (call.method === "GET" && call.path.endsWith("/toolchain/state")) {
      return { json: { tools: {}, image: { ...toolchainState, envVersion: 1 } } };
    }
    const m = /\/toolchain\/runs\/([^/]+)$/.exec(call.path);
    if (call.method === "GET" && m) {
      const run = toolchainRuns.get(m[1] as string);
      if (!run) return { status: 404, json: { error: "unknown run" } };
      const { reply } = run;
      const state = reply.state ?? "finished";
      const offset = Number(new URLSearchParams(call.query).get("offset") ?? 0);
      const log = reply.log ?? "";
      const steps = reply.steps ?? [];
      const tools: Record<string, ObservedTool> = { ...reply.tools };
      if (!reply.tools) {
        for (const s of steps) {
          if (s.status === "ok" && s.action !== "verify" && s.action !== "remove" && s.version) {
            tools[s.tool] = {
              version: s.version,
              previous: s.previous ?? null,
              backend: s.backend ?? "node",
              bins: [s.tool],
              sizeBytes: s.sizeBytes ?? 0,
              installedAt: "2026-03-10T12:00:00.000Z",
              observed: `${s.tool} ${s.version}`,
            };
          }
        }
      }
      const body: ToolchainRunResponse = {
        state,
        log: log.slice(offset),
        nextOffset: log.length,
        steps,
        result:
          state === "finished"
            ? { exitCode: 0, finishedAt: "2026-03-10T12:00:00.000Z", steps, tools }
            : null,
      };
      return { json: body };
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://x");
        const text = Buffer.concat(chunks).toString("utf8");
        const call: FakeCall = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.search,
          body: text ? (JSON.parse(text) as unknown) : undefined,
          auth: req.headers.authorization,
        };
        calls.push(call);
        if (call.auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "unauthorized" }));
        }
        const r = routes.get(`${call.method} ${call.path}`);
        const reply: Reply =
          typeof r === "function"
            ? await r(call)
            : (r ?? (await toolchainReply(call)) ?? defaultReply(call.method, call.path));
        if (reply === "hang") return;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.json ?? { ok: true }));
      })();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(socketPath, r));

  return {
    socketPath,
    toolchain,
    toolchainState,
    calls,
    on: (route, fn) => void routes.set(route, fn),
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
