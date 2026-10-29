import http from "node:http";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  BILLING_TIME_ZONE,
  decrypt,
  hashToken,
  parseWorkspaceHost,
  planGate,
  ports,
  randomToken,
  signGatewayIdentity,
  type PlanGateResult,
  type ServiceName,
} from "@agentbox/core";
import { readSetting } from "@agentbox/db/client";
import {
  creditBalances,
  handoffCodes,
  hostStats,
  plans,
  subscriptions,
  user,
  workspaceSessions,
  workspaces,
} from "@agentbox/db/schema";
import {
  capacityPage,
  creditsPage,
  dailyLimitPage,
  failedPage,
  messagePage,
  trialEndedPage,
  wakingPage,
} from "./html.ts";
import { errMessage } from "./log.ts";
import { enqueueJob } from "./queue.ts";
import type { Ctx } from "./types.ts";

function retryAfterSeconds(resumesAt: Date | undefined, now: Date): number {
  return resumesAt ? Math.max(1, Math.ceil((resumesAt.getTime() - now.getTime()) / 1000)) : 3600;
}

export const SESSION_COOKIE = "__Host-abx_ws";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const CACHE_TTL_MS = 30_000;
export const THROTTLE_MS = 30_000;
export const MAX_START_FAILURES = 3;
const DEFAULT_MAX_RUNNING_MEMORY_RATIO = 0.8;

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`;
}
export const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Lowercased Host header without port; null if absent. */
function normalizeHost(h: string | undefined): string | null {
  if (!h) return null;
  return h.toLowerCase().replace(/:\d+$/, "");
}

/** Only same-origin absolute paths: starts with a single `/`, no backslash or control chars. */
export function safeReturnPath(p: string | null | undefined): string {
  if (!p || !p.startsWith("/") || p.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return "/";
  return p;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  const raw = header(req, "cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function isNavigation(req: http.IncomingMessage): boolean {
  if (header(req, "sec-fetch-mode")?.toLowerCase() === "navigate") return true;
  const method = (header(req, "x-forwarded-method") ?? req.method ?? "GET").toUpperCase();
  return method === "GET" && (header(req, "accept") ?? "").toLowerCase().includes("text/html");
}

const BACKGROUND_PATH_PREFIXES = ["/api/observability/"];

/** Telemetry/heartbeat requests a browser tab sends with nobody present; they must not keep a workspace awake. */
export function isBackgroundRequest(forwardedUri: string | undefined): boolean {
  if (!forwardedUri) return false;
  const path = forwardedUri.split(/[?#]/, 1)[0] ?? "";
  return BACKGROUND_PATH_PREFIXES.some((p) => path.startsWith(p));
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(html);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

function sendEmpty(
  res: http.ServerResponse,
  status: number,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
  res.end();
}

interface SessionInfo {
  tokenHash: string;
  userId: string;
  email: string;
  workspaceId: string;
}
interface CacheEntry extends SessionInfo {
  host: string;
  until: number;
}

export function createGateway(ctx: Ctx): http.RequestListener {
  const { db, config } = ctx;
  const cache = new Map<string, CacheEntry>();
  const lastWrite = new Map<string, number>();

  async function resolveSession(
    req: http.IncomingMessage,
    host: string,
    ws: string,
  ): Promise<SessionInfo | null> {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const nowMs = ctx.now().getTime();
    const hit = cache.get(tokenHash);
    if (hit && hit.host === host && hit.until > nowMs) return hit;
    if (hit) cache.delete(tokenHash);

    const [row] = await db
      .select({
        userId: workspaceSessions.userId,
        workspaceId: workspaceSessions.workspaceId,
        expiresAt: workspaceSessions.expiresAt,
        email: user.email,
      })
      .from(workspaceSessions)
      .innerJoin(workspaces, eq(workspaces.id, workspaceSessions.workspaceId))
      .innerJoin(user, eq(user.id, workspaceSessions.userId))
      .where(
        and(
          eq(workspaceSessions.tokenHash, tokenHash),
          isNull(workspaceSessions.revokedAt),
          gt(workspaceSessions.expiresAt, ctx.now()),
          eq(workspaceSessions.host, host),
          eq(workspaces.slug, ws),
          ne(workspaces.status, "deleted"),
          eq(user.accessStatus, "active"),
        ),
      )
      .limit(1);
    if (!row) return null;
    const info: SessionInfo = {
      tokenHash,
      userId: row.userId,
      email: row.email,
      workspaceId: row.workspaceId,
    };
    if (cache.size > 2000) {
      for (const [k, v] of cache) if (v.until <= nowMs) cache.delete(k);
    }
    cache.set(tokenHash, {
      ...info,
      host,
      until: Math.min(nowMs + CACHE_TTL_MS, row.expiresAt.getTime()),
    });
    return info;
  }

  function deny(req: http.IncomingMessage, res: http.ServerResponse, host: string): void {
    if (isNavigation(req)) {
      const q = new URLSearchParams({
        host,
        path: safeReturnPath(header(req, "x-forwarded-uri")),
      });
      sendEmpty(res, 302, { location: `${config.appOrigin}/auth/handoff?${q}` });
    } else {
      sendJson(res, 401, { error: "unauthenticated" });
    }
  }

  async function canStart(
    userId: string,
  ): Promise<
    | { gate: PlanGateResult; memoryLimitMb: number; dailyRuntimeHours: number | null }
    | { gate: null; memoryLimitMb: 0; dailyRuntimeHours: null }
  > {
    const [row] = await db
      .select({
        plan: plans,
        sub: subscriptions,
        balance: creditBalances.balanceMicro,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .leftJoin(creditBalances, eq(creditBalances.userId, subscriptions.userId))
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    if (!row) return { gate: null, memoryLimitMb: 0, dailyRuntimeHours: null };
    const gate = planGate({
      plan: row.plan,
      subscription: row.sub,
      balanceMicro: row.balance ?? 0n,
      now: ctx.now(),
      timeZone: BILLING_TIME_ZONE,
    });
    return {
      gate,
      memoryLimitMb: row.plan.memoryLimitMb,
      dailyRuntimeHours: row.plan.dailyRuntimeHours,
    };
  }

  async function overCapacity(thisMemoryMb: number): Promise<boolean> {
    const [hs] = await db
      .select({ payload: hostStats.payload })
      .from(hostStats)
      .where(eq(hostStats.id, 1));
    const payload = hs?.payload as { host?: { memTotalBytes?: unknown } } | undefined;
    const memTotal = payload?.host?.memTotalBytes;
    if (typeof memTotal !== "number" || memTotal <= 0) return false;
    const [sum] = await db
      .select({ mb: sql<number>`coalesce(sum(${plans.memoryLimitMb}), 0)::int` })
      .from(workspaces)
      .innerJoin(subscriptions, eq(subscriptions.userId, workspaces.userId))
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(inArray(workspaces.status, ["running", "starting"]));
    const ratio =
      (await readSetting(db, "capacity"))?.maxRunningMemoryRatio ??
      DEFAULT_MAX_RUNNING_MEMORY_RATIO;
    return ((sum?.mb ?? 0) + thisMemoryMb) * 1024 * 1024 > ratio * memTotal;
  }

  async function authorize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    target: { ws: string; svc: ServiceName },
  ): Promise<void> {
    const session = await resolveSession(req, host, target.ws);
    if (!session) return deny(req, res, host);

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
    if (!ws || ws.status === "deleted" || ws.status === "deleting") {
      return sendJson(res, 404, { error: "not found" });
    }

    if (ws.status === "running") {
      const nowMs = ctx.now().getTime();
      const prev = lastWrite.get(ws.id) ?? 0;
      if (!isBackgroundRequest(header(req, "x-forwarded-uri")) && nowMs - prev >= THROTTLE_MS) {
        lastWrite.set(ws.id, nowMs);
        const now = ctx.now();
        await db
          .update(workspaces)
          .set({ lastRequestAt: now, lastActivityAt: now })
          .where(eq(workspaces.id, ws.id));
      }
      const headers: Record<string, string> = {
        "x-agentbox-upstream": `127.0.0.1:${ports(ws.slot)[target.svc]}`,
      };
      if (target.svc === "t3") {
        headers["x-gateway-identity"] = signGatewayIdentity({
          secret: decrypt(ws.identitySecretEnc, config.encryptionKey),
          audience: ws.slug,
          sub: session.userId,
          email: session.email,
          nowSeconds: Math.floor(nowMs / 1000),
        });
      }
      return sendEmpty(res, 200, headers);
    }

    const navigation = isNavigation(req);
    const retryHref = "/__abx/retry";

    if (ws.startFailures >= MAX_START_FAILURES) {
      return sendHtml(res, 503, failedPage({ ws: ws.slug, retryHref }), { "retry-after": "3" });
    }

    if (ws.status === "sleeping" || ws.status === "error") {
      const billing = await canStart(ws.userId);
      const billingUrl = `${config.appOrigin}/billing`;
      if (!billing.gate || billing.gate.reason === "credits_exhausted") {
        return sendHtml(res, 402, creditsPage({ ws: ws.slug, billingUrl }));
      }
      if (billing.gate.reason === "trial_ended") {
        return sendHtml(res, 402, trialEndedPage({ ws: ws.slug, billingUrl }));
      }
      if (billing.gate.reason === "daily_limit") {
        return sendHtml(
          res,
          429,
          dailyLimitPage({
            ws: ws.slug,
            hours: billing.dailyRuntimeHours ?? 0,
            billingUrl,
          }),
          { "retry-after": String(retryAfterSeconds(billing.gate.resumesAt, ctx.now())) },
        );
      }
      if (await overCapacity(billing.memoryLimitMb)) {
        return sendHtml(res, 503, capacityPage({ ws: ws.slug }), { "retry-after": "30" });
      }
      await enqueueJob(db, { type: "start_workspace", workspaceId: ws.id, payload: {} });
    }

    const detail =
      ws.status === "stopping"
        ? "The workspace is going to sleep and will start again in a moment."
        : "Your workspace is starting. This usually takes under a minute.";
    if (navigation) {
      return sendHtml(
        res,
        503,
        wakingPage({ ws: ws.slug, heading: "Waking up your workspace", detail }),
        {
          "retry-after": "3",
        },
      );
    }
    return sendJson(
      res,
      503,
      { status: ws.status === "stopping" ? "stopping" : "waking" },
      { "retry-after": "3" },
    );
  }

  async function callback(
    url: URL,
    res: http.ServerResponse,
    host: string,
    target: { ws: string },
  ): Promise<void> {
    const code = url.searchParams.get("code");
    const retryUrl = `${config.appOrigin}/auth/handoff?${new URLSearchParams({ host, path: "/" })}`;
    const invalid = () =>
      sendHtml(
        res,
        400,
        messagePage({
          title: "Sign-in link expired",
          message: "This sign-in link is invalid, expired or was already used.",
          href: retryUrl,
          linkText: "Sign in again",
        }),
      );
    if (!code) return invalid();

    // Atomic single use: only one concurrent request can flip used_at.
    const now = ctx.now();
    const [claimed] = await db
      .update(handoffCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(handoffCodes.codeHash, hashToken(code)),
          isNull(handoffCodes.usedAt),
          gt(handoffCodes.expiresAt, now),
          eq(handoffCodes.host, host),
        ),
      )
      .returning();
    if (!claimed) return invalid();

    const [row] = await db
      .select({ slug: workspaces.slug, status: workspaces.status, access: user.accessStatus })
      .from(workspaces)
      .innerJoin(user, eq(user.id, claimed.userId))
      .where(eq(workspaces.id, claimed.workspaceId));
    if (!row || row.slug !== target.ws || row.status === "deleted" || row.access !== "active") {
      return invalid();
    }

    const token = randomToken();
    await db.insert(workspaceSessions).values({
      tokenHash: hashToken(token),
      userId: claimed.userId,
      workspaceId: claimed.workspaceId,
      host,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
    sendEmpty(res, 302, {
      "set-cookie": sessionCookie(token),
      location: safeReturnPath(claimed.returnPath),
    });
  }

  async function logout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) {
      const tokenHash = hashToken(token);
      cache.delete(tokenHash);
      await db
        .update(workspaceSessions)
        .set({ revokedAt: ctx.now() })
        .where(
          and(eq(workspaceSessions.tokenHash, tokenHash), isNull(workspaceSessions.revokedAt)),
        );
    }
    sendEmpty(res, 302, { "set-cookie": CLEAR_COOKIE, location: `${config.appOrigin}/` });
  }

  async function retry(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    target: { ws: string },
  ): Promise<void> {
    const session = await resolveSession(req, host, target.ws);
    if (!session) return deny(req, res, host);
    const [ws] = await db
      .update(workspaces)
      .set({ startFailures: 0 })
      .where(
        and(
          eq(workspaces.id, session.workspaceId),
          inArray(workspaces.status, ["sleeping", "error"]),
        ),
      )
      .returning({ id: workspaces.id });
    if (ws) await enqueueJob(db, { type: "start_workspace", workspaceId: ws.id, payload: {} });
    sendEmpty(res, 302, { location: "/" });
  }

  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://gateway.invalid");
        const path = url.pathname;
        const known = ["/internal/authorize", "/__abx/callback", "/__abx/logout", "/__abx/retry"];
        if (!known.includes(path)) return sendJson(res, 404, { error: "not found" });
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
        }
        const host = normalizeHost(header(req, "host"));
        const target = host ? parseWorkspaceHost(host, config.baseDomain) : null;
        if (!host || !target) return sendJson(res, 404, { error: "not found" });

        switch (path) {
          case "/internal/authorize":
            return await authorize(req, res, host, target);
          case "/__abx/callback":
            return await callback(url, res, host, target);
          case "/__abx/logout":
            return await logout(req, res);
          default:
            return await retry(req, res, host, target);
        }
      } catch (e) {
        ctx.log.error("gateway request failed", { error: errMessage(e) });
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      }
    })();
  };
}
