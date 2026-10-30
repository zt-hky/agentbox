import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  buildImageRequestSchema,
  createTenantRequestSchema,
  githubConnectRequestSchema,
  imageParamsSchema,
  jobParamsSchema,
  logQuerySchema,
  startWorkspaceRequestSchema,
  updateLimitsRequestSchema,
  workspaceLogQuerySchema,
  wsParamsSchema,
} from "@agentbox/core/agent-api";
import { copilotProviderRequestSchema } from "@agentbox/core/accounts";
import { checkBearer } from "./auth.ts";
import { MAX_BODY_BYTES } from "./config.ts";
import { HttpError } from "./errors.ts";
import { asHttpError } from "./exec.ts";
import { buildImage, deleteImage, readBuildLog } from "./images.ts";
import { errMessage, logEvent } from "./log.ts";
import { collectStats } from "./stats.ts";
import { createTenant, deleteTenant, updateLimits } from "./tenants.ts";
import {
  copilotLoginCancelOp,
  copilotLoginStartOp,
  copilotLoginStateOp,
  copilotLogoutOp,
  copilotProviderOp,
  githubConnect,
  githubDisconnect,
  startWorkspace,
  stopWorkspace,
  workspaceLogs,
  workspaceTop,
} from "./workspaces.ts";

const OK = { ok: true } as const;

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<unknown>;
}
type Handler = (c: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return r.data;
}

export const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/v1\/tenants$/,
    handler: async (c) => {
      await createTenant(parse(createTenantRequestSchema, await c.body()));
      return OK;
    },
  },
  {
    method: "PUT",
    pattern: /^\/v1\/tenants\/([^/]+)\/limits$/,
    handler: async (c) => {
      const { ws } = parse(wsParamsSchema, { ws: c.params["0"] });
      await updateLimits(ws, parse(updateLimitsRequestSchema, await c.body()));
      return OK;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/tenants\/([^/]+)$/,
    handler: async (c) => {
      await deleteTenant(parse(wsParamsSchema, { ws: c.params["0"] }).ws);
      return OK;
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/workspaces\/([^/]+)\/start$/,
    handler: async (c) => {
      const { ws } = parse(wsParamsSchema, { ws: c.params["0"] });
      return startWorkspace(ws, parse(startWorkspaceRequestSchema, await c.body()));
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/workspaces\/([^/]+)\/stop$/,
    handler: async (c) => {
      await stopWorkspace(parse(wsParamsSchema, { ws: c.params["0"] }).ws);
      return OK;
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/workspaces\/([^/]+)\/github$/,
    handler: async (c) => {
      const { ws } = parse(wsParamsSchema, { ws: c.params["0"] });
      await githubConnect(ws, parse(githubConnectRequestSchema, await c.body()));
      return OK;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/workspaces\/([^/]+)\/github$/,
    handler: async (c) => {
      await githubDisconnect(parse(wsParamsSchema, { ws: c.params["0"] }).ws);
      return OK;
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/workspaces\/([^/]+)\/copilot\/login$/,
    handler: (c) => copilotLoginStartOp(parse(wsParamsSchema, { ws: c.params["0"] }).ws),
  },
  {
    method: "GET",
    pattern: /^\/v1\/workspaces\/([^/]+)\/copilot\/login$/,
    handler: (c) => copilotLoginStateOp(parse(wsParamsSchema, { ws: c.params["0"] }).ws),
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/workspaces\/([^/]+)\/copilot\/login$/,
    handler: async (c) => {
      await copilotLoginCancelOp(parse(wsParamsSchema, { ws: c.params["0"] }).ws);
      return OK;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/workspaces\/([^/]+)\/copilot$/,
    handler: async (c) => {
      await copilotLogoutOp(parse(wsParamsSchema, { ws: c.params["0"] }).ws);
      return OK;
    },
  },
  {
    method: "PUT",
    pattern: /^\/v1\/workspaces\/([^/]+)\/copilot\/provider$/,
    handler: async (c) => {
      const { ws } = parse(wsParamsSchema, { ws: c.params["0"] });
      await copilotProviderOp(ws, parse(copilotProviderRequestSchema, await c.body()));
      return OK;
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/workspaces\/([^/]+)\/logs$/,
    handler: async (c) => {
      const { ws } = parse(wsParamsSchema, { ws: c.params["0"] });
      const { tail } = parse(workspaceLogQuerySchema, Object.fromEntries(c.query));
      return workspaceLogs(ws, tail);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/workspaces\/([^/]+)\/top$/,
    handler: async (c) => workspaceTop(parse(wsParamsSchema, { ws: c.params["0"] }).ws),
  },
  { method: "GET", pattern: /^\/v1\/stats$/, handler: () => collectStats() },
  {
    method: "POST",
    pattern: /^\/v1\/images\/build$/,
    handler: async (c) => buildImage(parse(buildImageRequestSchema, await c.body())),
  },
  {
    method: "GET",
    pattern: /^\/v1\/images\/build\/([^/]+)\/log$/,
    handler: async (c) => {
      const { jobId } = parse(jobParamsSchema, { jobId: c.params["0"] });
      const { tail } = parse(logQuerySchema, Object.fromEntries(c.query));
      return { log: await readBuildLog(jobId, tail) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/images\/([^/]+)$/,
    handler: async (c) => {
      await deleteImage(parse(imageParamsSchema, { imageId: c.params["0"] }).imageId);
      return OK;
    },
  },
];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function createAgentServer(token: string): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!checkBearer(req.headers.authorization, token))
          throw new HttpError(401, "unauthorized");
        const url = new URL(req.url ?? "/", "http://agent");
        let pathMatched = false;
        for (const r of routes) {
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          const params: Record<string, string> = {};
          m.slice(1).forEach((v, i) => {
            try {
              params[String(i)] = decodeURIComponent(v);
            } catch {
              throw new HttpError(400, "invalid path encoding");
            }
          });
          let cached: Promise<unknown> | undefined;
          const result = await r.handler({
            params,
            query: url.searchParams,
            body: () => (cached ??= readBody(req)),
          });
          return send(res, 200, result);
        }
        throw new HttpError(
          pathMatched ? 405 : 404,
          pathMatched ? "method not allowed" : "not found",
        );
      } catch (e) {
        const he = asHttpError(e);
        if (he.status >= 500)
          logEvent({
            event: "request_failed",
            status: he.status,
            error: errMessage(he).slice(0, 300),
          });
        if (!res.headersSent) send(res, he.status, { error: he.message });
        else res.destroy();
      }
    })();
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}
