import { auditLog } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip: string | null;
}

export async function writeAudit(database: DbLike, entry: AuditEntry): Promise<void> {
  await database.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
    ip: entry.ip,
  });
}

/** Client IP: Cloudflare's header first (Caddy only trusts it from loopback), then XFF. */
export function clientIpFrom(h: { get(name: string): string | null }): string | null {
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff.slice(0, 64);
  return h.get("x-real-ip")?.trim().slice(0, 64) || null;
}
