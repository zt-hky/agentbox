import { scanSummarySchema, type ScanSummary } from "@agentbox/core/agent-api";
import { UserError } from "./errors";

export function parseScanSummary(raw: unknown): ScanSummary | null {
  const r = scanSummarySchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Activation rule: fixable CRITICAL vulnerabilities (or a missing scan) block activation unless the
 * admin supplies an override reason, which is stored in `images.overrideReason`.
 */
export function activationOverride(
  scanSummary: unknown,
  overrideReason: string | null | undefined,
): { overrideReason: string | null } {
  const scan = parseScanSummary(scanSummary);
  const blocked = scan === null || scan.fixableCritical > 0;
  const reason = overrideReason?.trim() || null;
  if (blocked && !reason) {
    throw new UserError(
      scan === null
        ? "No scan results are available; an override reason is required"
        : `${scan.fixableCritical} fixable CRITICAL vulnerabilities; an override reason is required`,
    );
  }
  return { overrideReason: blocked ? reason : null };
}

export const BUILD_LOG_MAX_CHARS = 20_000;

export function tailLog(log: string | null | undefined): string {
  if (!log) return "";
  return log.length > BUILD_LOG_MAX_CHARS ? log.slice(-BUILD_LOG_MAX_CHARS) : log;
}
