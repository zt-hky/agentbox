import http from "node:http";
import type { z } from "zod";
import {
  buildImageResponseSchema,
  buildLogResponseSchema,
  errorResponseSchema,
  okResponseSchema,
  startWorkspaceResponseSchema,
  workspaceLogResponseSchema,
  workspaceTopResponseSchema,
  statsResponseSchema,
  type BuildImageRequest,
  type BuildImageResponse,
  type CreateTenantRequest,
  type GithubConnectRequest,
  type StartWorkspaceRequest,
  type StartWorkspaceResponse,
  type StatsResponse,
  type UpdateLimitsRequest,
  type WorkspaceLogResponse,
  type WorkspaceTopResponse,
} from "@agentbox/core/agent-api";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Carries the agent's `{error}` body (or the transport failure) and the HTTP status if any. */
export class AgentError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}

export interface AgentClient {
  createTenant(req: CreateTenantRequest): Promise<void>;
  updateLimits(ws: string, req: UpdateLimitsRequest): Promise<void>;
  deleteTenant(ws: string): Promise<void>;
  startWorkspace(ws: string, req: StartWorkspaceRequest): Promise<StartWorkspaceResponse>;
  stopWorkspace(ws: string): Promise<void>;
  githubConnect(ws: string, req: GithubConnectRequest): Promise<void>;
  githubDisconnect(ws: string): Promise<void>;
  workspaceLogs(ws: string, tail: number): Promise<WorkspaceLogResponse>;
  workspaceTop(ws: string): Promise<WorkspaceTopResponse>;
  stats(): Promise<StatsResponse>;
  buildImage(req: BuildImageRequest): Promise<BuildImageResponse>;
  buildLog(jobId: string, tail: number): Promise<string>;
  deleteImage(imageId: string): Promise<void>;
}

export interface AgentClientOptions {
  socketPath: string;
  token: string;
  timeoutMs?: number;
  buildTimeoutMs?: number;
}

export function createAgentClient(opts: AgentClientOptions): AgentClient {
  const timeoutDefault = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutBuild = opts.buildTimeoutMs ?? BUILD_TIMEOUT_MS;

  function raw(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | number> = {
        authorization: `Bearer ${opts.token}`,
        accept: "application/json",
      };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = http.request({ socketPath: opts.socketPath, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) =>
          done(() => reject(new AgentError(`agent connection error: ${e.message}`, null))),
        );
        res.on("end", () =>
          done(() =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
          ),
        );
      });
      const timer = setTimeout(() => {
        const err = new AgentError(
          `agent request ${method} ${path} timed out after ${timeoutMs}ms`,
          null,
        );
        done(() => reject(err));
        req.destroy();
      }, timeoutMs);
      req.on("error", (e) =>
        done(() => reject(new AgentError(`agent connection error: ${e.message}`, null))),
      );
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async function call<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
    timeoutMs = timeoutDefault,
  ): Promise<z.infer<S>> {
    const { status, text } = await raw(method, path, body, timeoutMs);
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (status < 200 || status >= 300) {
      const e = errorResponseSchema.safeParse(json);
      const msg = e.success ? e.data.error : text.slice(0, 500) || `HTTP ${status}`;
      throw new AgentError(msg, status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AgentError(
        `agent returned an invalid response for ${method} ${path}: ${parsed.error.message}`,
        status,
      );
    }
    return parsed.data;
  }

  const seg = encodeURIComponent;
  return {
    async createTenant(req) {
      await call("POST", "/v1/tenants", req, okResponseSchema);
    },
    async updateLimits(ws, req) {
      await call("PUT", `/v1/tenants/${seg(ws)}/limits`, req, okResponseSchema);
    },
    async deleteTenant(ws) {
      await call("DELETE", `/v1/tenants/${seg(ws)}`, undefined, okResponseSchema);
    },
    startWorkspace(ws, req) {
      return call("POST", `/v1/workspaces/${seg(ws)}/start`, req, startWorkspaceResponseSchema);
    },
    async stopWorkspace(ws) {
      await call("POST", `/v1/workspaces/${seg(ws)}/stop`, {}, okResponseSchema);
    },
    async githubConnect(ws, req) {
      await call("POST", `/v1/workspaces/${seg(ws)}/github`, req, okResponseSchema);
    },
    async githubDisconnect(ws) {
      await call("DELETE", `/v1/workspaces/${seg(ws)}/github`, undefined, okResponseSchema);
    },
    workspaceLogs(ws, tail) {
      return call(
        "GET",
        `/v1/workspaces/${seg(ws)}/logs?tail=${tail}`,
        undefined,
        workspaceLogResponseSchema,
      );
    },
    workspaceTop(ws) {
      return call("GET", `/v1/workspaces/${seg(ws)}/top`, undefined, workspaceTopResponseSchema);
    },
    stats() {
      return call("GET", "/v1/stats", undefined, statsResponseSchema);
    },
    buildImage(req) {
      return call("POST", "/v1/images/build", req, buildImageResponseSchema, timeoutBuild);
    },
    async buildLog(jobId, tail) {
      const r = await call(
        "GET",
        `/v1/images/build/${seg(jobId)}/log?tail=${tail}`,
        undefined,
        buildLogResponseSchema,
      );
      return r.log;
    },
    async deleteImage(imageId) {
      await call("DELETE", `/v1/images/${seg(imageId)}`, undefined, okResponseSchema);
    },
  };
}
