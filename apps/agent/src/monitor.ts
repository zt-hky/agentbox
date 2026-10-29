import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmod, chown, rm } from "node:fs/promises";
import { CP_USER, MONITOR_SOCKET_PATH, MONITOR_USER } from "./config.ts";
import { run } from "./exec.ts";
import { errMessage, logEvent } from "./log.ts";
import { registry } from "./state.ts";

/**
 * Docker-compatible, read-only view of the Podman API sockets for monitoring tools (Beszel).
 * Access control is the socket's ownership (0600, MONITOR_USER); there is no bearer token.
 * Tenant containers appear as `ws-<slug>`; their logs are never served.
 */

export interface Upstream {
  /** "cp" for the control plane, otherwise the workspace slug. */
  name: string;
  socketPath: string;
}

export const CP_UPSTREAM = "cp";
const UPSTREAM_TIMEOUT_MS = 2000;
const TENANT_CONTAINER_NAME = "abx-ws";

export type Route =
  | { kind: "list" }
  | { kind: "forward" }
  | { kind: "container"; id: string; action: "stats" | "json" | "logs" };

/** Strips an optional `/v1.NN` prefix and allow-lists the supported paths; null = forbidden. */
export function matchRoute(pathname: string): Route | null {
  const path = pathname.replace(/^\/v1\.\d{1,3}(?=\/)/, "");
  if (path === "/_ping" || path === "/version" || path === "/info") return { kind: "forward" };
  if (path === "/containers/json") return { kind: "list" };
  const m = /^\/containers\/([0-9a-f]{12,64})\/(stats|json|logs)$/.exec(path);
  if (m)
    return { kind: "container", id: m[1] as string, action: m[2] as "stats" | "json" | "logs" };
  return null;
}

/** Full id or a prefix of at least 12 chars; undefined when unknown or ambiguous. */
export function resolveId(map: ReadonlyMap<string, string>, id: string): string | undefined {
  const exact = map.get(id);
  if (exact !== undefined) return exact;
  if (id.length < 12) return undefined;
  let found: string | undefined;
  for (const [full, up] of map) {
    if (!full.startsWith(id)) continue;
    if (found !== undefined && found !== up) return undefined;
    found = up;
  }
  return found;
}

/** `/abx-ws` → `/ws-<slug>` (a leading slash is preserved); other names are untouched. */
export function rewriteName(name: string, upstream: string): string {
  if (upstream === CP_UPSTREAM) return name;
  const slash = name.startsWith("/") ? "/" : "";
  return name.slice(slash.length) === TENANT_CONTAINER_NAME ? `${slash}ws-${upstream}` : name;
}

interface ListedContainer {
  Id?: unknown;
  Names?: unknown;
  [k: string]: unknown;
}

export function rewriteListed(c: ListedContainer, upstream: string): ListedContainer {
  if (!Array.isArray(c.Names)) return c;
  return {
    ...c,
    Names: c.Names.map((n) => (typeof n === "string" ? rewriteName(n, upstream) : n)),
  };
}

/** Inspect output without `Config.Env` (control-plane containers hold secrets there) and renamed. */
export function sanitizeInspect(doc: unknown, upstream: string): unknown {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  const out: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  const cfg = out.Config;
  if (typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)) {
    const rest: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
    delete rest.Env;
    out.Config = rest;
  }
  if (typeof out.Name === "string") out.Name = rewriteName(out.Name, upstream);
  return out;
}

export function podmanSocketPath(uid: number): string {
  return `/run/user/${uid}/podman/podman.sock`;
}

/** Makes sure `podman.socket` is listening in `user`'s manager; failures are logged, never thrown. */
export async function ensurePodmanSocket(user: string): Promise<void> {
  const r = await run("systemctl", ["--user", "-M", `${user}@`, "start", "podman.socket"], {
    check: false,
    timeoutMs: 15_000,
  }).catch((e) => ({ code: -1, stdout: "", stderr: errMessage(e) }));
  if (r.code !== 0)
    logEvent({ event: "podman_socket_failed", user, error: r.stderr.trim().slice(0, 200) });
}

interface UpstreamResponse {
  status: number;
  headers: IncomingMessage["headers"];
  stream: IncomingMessage;
}

function upstreamGet(
  up: Upstream,
  pathAndQuery: string,
  timeoutMs?: number,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: up.socketPath, path: pathAndQuery, method: "GET" },
      (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, stream: res }),
    );
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function readAll(stream: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > maxBytes) throw new Error("upstream body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

export interface MonitorDeps {
  upstreams: () => Upstream[] | Promise<Upstream[]>;
}

export function createMonitorServer(deps: MonitorDeps): Server {
  const idMap = new Map<string, string>();
  const failing = new Set<string>();
  let serverHeader: string | undefined;

  const note = (up: Upstream, headers: IncomingMessage["headers"]) => {
    if (up.name === CP_UPSTREAM && typeof headers.server === "string")
      serverHeader = headers.server;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      ...(serverHeader ? { server: serverHeader } : {}),
    });
    res.end(text);
  };

  const pipeThrough = (res: ServerResponse, up: UpstreamResponse, clientReq: IncomingMessage) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers))
      if (v !== undefined && !HOP.has(k)) headers[k] = v;
    res.writeHead(up.status, headers);
    clientReq.on("close", () => up.stream.destroy());
    up.stream.on("error", () => res.destroy());
    up.stream.pipe(res);
  };

  /** Queries every upstream in parallel; returns merged (renamed) containers and refreshes the id map. */
  async function listAll(query: string): Promise<ListedContainer[]> {
    const ups = await deps.upstreams();
    const names = new Set(ups.map((u) => u.name));
    for (const [id, name] of idMap) if (!names.has(name)) idMap.delete(id);
    const parts = await Promise.all(
      ups.map(async (up) => {
        try {
          const r = await upstreamGet(up, `/containers/json${query}`, UPSTREAM_TIMEOUT_MS);
          const body = await readAll(r.stream);
          if (r.status !== 200) throw new Error(`status ${r.status}`);
          const list = JSON.parse(body.toString("utf8")) as ListedContainer[];
          if (!Array.isArray(list)) throw new Error("unexpected list body");
          note(up, r.headers);
          failing.delete(up.name);
          return list.map((c) => {
            if (typeof c.Id === "string") idMap.set(c.Id, up.name);
            return rewriteListed(c, up.name);
          });
        } catch (e) {
          if (!failing.has(up.name)) {
            failing.add(up.name);
            logEvent({ event: "monitor_upstream_failed", upstream: up.name, error: errMessage(e) });
          }
          return [];
        }
      }),
    );
    return parts.flat();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") return sendJson(res, 405, { message: "method not allowed" });
    const url = new URL(req.url ?? "/", "http://monitor");
    const route = matchRoute(url.pathname);
    if (!route) return sendJson(res, 403, { message: "forbidden" });
    const query = url.search;

    if (route.kind === "list") return sendJson(res, 200, await listAll(query));

    let up: Upstream | undefined;
    const ups = await deps.upstreams();
    if (route.kind === "forward") {
      up = ups.find((u) => u.name === CP_UPSTREAM);
    } else {
      let owner = resolveId(idMap, route.id);
      if (owner === undefined) {
        await listAll("?all=1");
        owner = resolveId(idMap, route.id);
      }
      if (owner === undefined) return sendJson(res, 404, { message: "no such container" });
      if (route.action === "logs" && owner !== CP_UPSTREAM)
        return sendJson(res, 403, { message: "workspace logs are not available here" });
      up = ups.find((u) => u.name === owner);
    }
    if (!up) return sendJson(res, 502, { message: "upstream unavailable" });

    let r: UpstreamResponse;
    try {
      r = await upstreamGet(up, `${url.pathname.replace(/^\/v1\.\d{1,3}(?=\/)/, "")}${query}`);
    } catch (e) {
      if (!failing.has(up.name)) {
        failing.add(up.name);
        logEvent({ event: "monitor_upstream_failed", upstream: up.name, error: errMessage(e) });
      }
      return sendJson(res, 502, { message: "upstream unavailable" });
    }
    failing.delete(up.name);
    note(up, r.headers);

    if (route.kind === "container" && route.action === "json" && r.status === 200) {
      const body = JSON.parse((await readAll(r.stream)).toString("utf8")) as unknown;
      return sendJson(res, 200, sanitizeInspect(body, up.name));
    }
    pipeThrough(res, r, req);
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      logEvent({ event: "monitor_request_failed", error: errMessage(e).slice(0, 200) });
      if (!res.headersSent) sendJson(res, 502, { message: "bad gateway" });
      else res.destroy();
    });
  });
}

async function lookupId(flag: "-u" | "-g", user: string): Promise<number | null> {
  const r = await run("id", [flag, user], { check: false });
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

/** Starts the monitor listener; returns a closer, or null when MONITOR_USER does not exist. */
export async function startMonitor(): Promise<(() => void) | null> {
  const uid = await lookupId("-u", MONITOR_USER);
  const gid = await lookupId("-g", MONITOR_USER);
  if (uid === null || gid === null) {
    logEvent({ event: "monitor_skipped", reason: "user not found", user: MONITOR_USER });
    return null;
  }
  const cpUid = await lookupId("-u", CP_USER);
  await ensurePodmanSocket(CP_USER);
  const server = createMonitorServer({
    upstreams: () => [
      ...(cpUid === null ? [] : [{ name: CP_UPSTREAM, socketPath: podmanSocketPath(cpUid) }]),
      ...[...registry.values()].map((w) => ({
        name: w.ws,
        socketPath: podmanSocketPath(w.uid),
      })),
    ],
  });
  await rm(MONITOR_SOCKET_PATH, { force: true });
  const prev = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(MONITOR_SOCKET_PATH, () => resolve());
    });
  } finally {
    process.umask(prev);
  }
  await chown(MONITOR_SOCKET_PATH, uid, gid);
  await chmod(MONITOR_SOCKET_PATH, 0o600);
  logEvent({ event: "monitor_listening", user: MONITOR_USER });
  return () => server.close();
}
