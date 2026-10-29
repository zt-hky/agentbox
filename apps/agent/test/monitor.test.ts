import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMonitorServer,
  matchRoute,
  resolveId,
  rewriteName,
  sanitizeInspect,
} from "../src/monitor.ts";

const CP_ID = "a".repeat(64);
const WS_ID = "b".repeat(64);

describe("matchRoute", () => {
  it("allow-lists container reads and forwards, with or without a version prefix", () => {
    expect(matchRoute("/containers/json")).toEqual({ kind: "list" });
    expect(matchRoute("/v1.41/containers/json")).toEqual({ kind: "list" });
    expect(matchRoute(`/v1.43/containers/${CP_ID}/stats`)).toEqual({
      kind: "container",
      id: CP_ID,
      action: "stats",
    });
    expect(matchRoute("/containers/aaaaaaaaaaaa/logs")).toEqual({
      kind: "container",
      id: "aaaaaaaaaaaa",
      action: "logs",
    });
    for (const p of ["/version", "/info", "/_ping", "/v1.41/info"])
      expect(matchRoute(p)).toEqual({ kind: "forward" });
  });

  it("rejects everything else", () => {
    for (const p of [
      "/",
      "/containers/aaaaaaaaaaaa/exec",
      "/containers/aaaaaaaaaaaa/archive",
      "/containers/short/json",
      "/containers/../info",
      "/libpod/containers/json",
      "/v1/containers/json",
      "/images/json",
      "/containers/json/extra",
    ])
      expect(matchRoute(p), p).toBeNull();
  });
});

describe("resolveId", () => {
  const map = new Map([
    [CP_ID, "cp"],
    [WS_ID, "etoe"],
    ["c".repeat(60) + "0001", "kynguyen"],
    ["c".repeat(60) + "0002", "etoe"],
  ]);
  it("matches a full id or a 12-char prefix", () => {
    expect(resolveId(map, CP_ID)).toBe("cp");
    expect(resolveId(map, WS_ID.slice(0, 12))).toBe("etoe");
  });
  it("returns undefined for unknown ids and ambiguous prefixes across upstreams", () => {
    expect(resolveId(map, "d".repeat(12))).toBeUndefined();
    expect(resolveId(map, "c".repeat(12))).toBeUndefined();
  });
});

describe("rewriteName / sanitizeInspect", () => {
  it("renames only the tenant workspace container, keeping the slash form", () => {
    expect(rewriteName("/abx-ws", "etoe")).toBe("/ws-etoe");
    expect(rewriteName("abx-ws", "etoe")).toBe("ws-etoe");
    expect(rewriteName("/agentbox-web", "cp")).toBe("/agentbox-web");
    expect(rewriteName("/abx-ws", "cp")).toBe("/abx-ws");
    expect(rewriteName("/something", "etoe")).toBe("/something");
  });

  it("drops Config.Env but keeps Cmd and the rest", () => {
    const out = sanitizeInspect(
      { Name: "/abx-ws", Config: { Env: ["SECRET=1"], Cmd: ["run"], Image: "x" }, State: {} },
      "etoe",
    ) as { Name: string; Config: Record<string, unknown> };
    expect(out.Config).toEqual({ Cmd: ["run"], Image: "x" });
    expect(out.Name).toBe("/ws-etoe");
  });
});

describe("monitor server", () => {
  const dir = mkdtempSync(join(tmpdir(), "abx-monitor-"));
  const servers: Server[] = [];
  const hits: Record<string, string[]> = { cp: [], etoe: [] };

  const fake = (name: string, id: string, names: string[]) =>
    new Promise<string>((resolve) => {
      const sock = join(dir, `${name}.sock`);
      const s = createServer((req, res) => {
        hits[name]?.push(req.url ?? "");
        res.setHeader("server", "Libpod/5.0");
        res.setHeader("content-type", "application/json");
        if (req.url?.startsWith("/containers/json"))
          return void res.end(JSON.stringify([{ Id: id, Names: names }]));
        if (req.url?.endsWith("/json"))
          return void res.end(JSON.stringify({ Id: id, Name: names[0], Config: { Env: ["K=v"] } }));
        res.end(JSON.stringify({ path: req.url }));
      });
      servers.push(s);
      s.listen(sock, () => resolve(sock));
    });

  let monitor: string;
  const call = (method: string, path: string) =>
    new Promise<{ status: number; body: string; server?: string }>((resolve, reject) => {
      const r = request({ socketPath: monitor, path, method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, server: res.headers.server as string }),
        );
      });
      r.on("error", reject);
      r.end();
    });

  beforeAll(async () => {
    const cp = await fake("cp", CP_ID, ["agentbox-web"]);
    const ws = await fake("etoe", WS_ID, ["abx-ws"]);
    const m = createMonitorServer({
      upstreams: () => [
        { name: "cp", socketPath: cp },
        { name: "etoe", socketPath: ws },
        { name: "gone", socketPath: join(dir, "missing.sock") },
      ],
    });
    servers.push(m);
    monitor = join(dir, "monitor.sock");
    await new Promise<void>((r) => m.listen(monitor, () => r()));
  });
  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges upstreams, skips dead ones and renames tenant containers", async () => {
    const r = await call("GET", "/v1.41/containers/json?all=1");
    expect(r.status).toBe(200);
    expect(r.server).toBe("Libpod/5.0");
    const names = (JSON.parse(r.body) as { Names: string[] }[]).flatMap((c) => c.Names);
    expect(names.sort()).toEqual(["agentbox-web", "ws-etoe"]);
  });

  it("routes by id prefix and strips Env from inspect", async () => {
    const r = await call("GET", `/containers/${WS_ID.slice(0, 12)}/json`);
    expect(r.status).toBe(200);
    const doc = JSON.parse(r.body) as { Name: string; Config: object };
    expect(doc.Name).toBe("ws-etoe");
    expect(doc.Config).not.toHaveProperty("Env");
    const s = await call("GET", `/containers/${CP_ID.slice(0, 12)}/stats?stream=0&one-shot=1`);
    expect(JSON.parse(s.body)).toEqual({
      path: `/containers/${CP_ID.slice(0, 12)}/stats?stream=0&one-shot=1`,
    });
  });

  it("serves control-plane logs but denies tenant logs without contacting the tenant", async () => {
    expect((await call("GET", `/containers/${CP_ID.slice(0, 12)}/logs?stdout=1`)).status).toBe(200);
    const before = hits.etoe?.length;
    expect((await call("GET", `/containers/${WS_ID.slice(0, 12)}/logs?stdout=1`)).status).toBe(403);
    expect(hits.etoe?.length).toBe(before);
  });

  it("returns 404 for unknown ids, 405 for non-GET and 403 for unknown paths", async () => {
    expect((await call("GET", `/containers/${"e".repeat(12)}/stats`)).status).toBe(404);
    expect((await call("POST", "/containers/json")).status).toBe(405);
    expect((await call("DELETE", `/containers/${CP_ID.slice(0, 12)}/json`)).status).toBe(405);
    expect((await call("GET", "/containers/create")).status).toBe(403);
  });

  it("forwards /version to the control plane only", async () => {
    const before = hits.etoe?.length;
    expect((await call("GET", "/version")).status).toBe(200);
    expect(hits.cp).toContain("/version");
    expect(hits.etoe?.length).toBe(before);
  });
});
