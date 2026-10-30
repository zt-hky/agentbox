import Link from "next/link";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DashboardToolSummary } from "@/lib/dashboard";

/** What is installed in the workspace, with shortcuts into the /tools install, remove and update UI. */
export function ToolsSummary({ summary }: { summary: DashboardToolSummary }) {
  const { tools, counts, run } = summary;
  const parts = [
    `${counts.installed} installed`,
    counts.pending > 0 ? `${counts.pending} waiting` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
  ].filter(Boolean);
  return (
    <Section
      title="Tools in your workspace"
      description={
        tools.length === 0
          ? "Nothing is installed yet."
          : `${parts.join(", ")}.${run?.open ? ` A change is running: ${run.done} of ${run.total} steps.` : ""}`
      }
      actions={
        <>
          <Button asChild size="sm">
            <Link href="/tools">Install tools</Link>
          </Button>
          {counts.updates > 0 ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/tools">Update {counts.updates}</Link>
            </Button>
          ) : null}
          {counts.installed > 0 ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/tools">Uninstall</Link>
            </Button>
          ) : null}
        </>
      }
      bodyClassName={tools.length === 0 ? undefined : "p-0"}
    >
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Pick languages and agent CLIs under Tools. They install into <Mono>~/.agentbox/bin</Mono>.
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {tools.map((t) => (
            <li key={t.toolId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
              <span className="min-w-32 font-medium">{t.label}</span>
              <span className="w-28">
                {t.installedVersion ? (
                  <Mono>{t.installedVersion}</Mono>
                ) : (
                  <span className="text-muted-foreground">Not installed</span>
                )}
              </span>
              <StatusBadge status={t.state} />
              {t.updateAvailable ? (
                <Badge variant="status">Update {t.updateAvailable}</Badge>
              ) : null}
              {t.state === "failed" && t.lastError ? (
                <span className="min-w-0 flex-1 truncate text-meta text-destructive">
                  {t.lastError}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
