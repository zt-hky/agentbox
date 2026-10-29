import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export interface FakeAgent {
  socketPath: string;
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
  return { json: { ok: true } };
}

export async function startFakeAgent(): Promise<FakeAgent> {
  const dir = mkdtempSync(join(tmpdir(), "abx-fake-agent-"));
  const socketPath = join(dir, "agent.sock");
  const calls: FakeCall[] = [];
  const routes = new Map<string, RouteFn | Reply>();
  const sockets = new Set<import("node:net").Socket>();

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
          typeof r === "function" ? await r(call) : (r ?? defaultReply(call.method, call.path));
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
