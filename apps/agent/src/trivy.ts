import type { ScanSummary } from "@agentbox/core/agent-api";

/** Counts per severity plus CRITICAL findings that have a fixed version. */
export function summarizeTrivy(json: string): ScanSummary {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  let fixableCritical = 0;
  const doc = JSON.parse(json) as {
    Results?: { Vulnerabilities?: { Severity?: string; FixedVersion?: string }[] | null }[] | null;
  };
  for (const r of doc.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      const sev = (v.Severity ?? "UNKNOWN").toUpperCase();
      const key = sev in counts ? (sev as keyof typeof counts) : "UNKNOWN";
      counts[key] += 1;
      if (key === "CRITICAL" && v.FixedVersion) fixableCritical += 1;
    }
  }
  return { counts, fixableCritical };
}
