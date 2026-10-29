"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { fetchLogsResultSchema, inspectWorkspaceResultSchema } from "@agentbox/core/job-contracts";
import { CodeBlock } from "@/components/code-block";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import {
  LOG_TAILS,
  formatProcessTable,
  jobActive,
  nextPollDelayMs,
  type JobView,
  type LogTail,
} from "@/lib/admin/workspaces";
import { formatAgo, formatDateTime } from "@/lib/format";
import { adminPollJob, adminRunDiagnostic } from "./actions";

interface Props {
  slug: string;
  kind: "processes" | "logs";
  /** The workspace is running, so a diagnostic job can be queued. */
  running: boolean;
  initialLatest: JobView | null;
  initialDone: JobView | null;
  /** Server render time (ISO); ages are measured from the last server or poll response. */
  now: string;
}

/**
 * Queues `inspect_workspace` / `fetch_logs`, then polls the job row through a server action every
 * 2 s until it is done or failed (or the poll budget runs out), and shows the latest result.
 */
export function DiagnosticPanel({ slug, kind, running, initialLatest, initialDone, now }: Props) {
  const [latest, setLatest] = useState(initialLatest);
  const [done, setDone] = useState(initialDone);
  const [clock, setClock] = useState(() => new Date(now));
  const [tail, setTail] = useState<LogTail>(500);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [pending, start] = useTransition();
  const waitStart = useRef<number | null>(null);

  const active = latest !== null && jobActive(latest.status);

  useEffect(() => {
    if (!latest || !jobActive(latest.status)) return;
    waitStart.current ??= performance.now();
    const delay = nextPollDelayMs(latest.status, performance.now() - waitStart.current);
    if (delay === null) return;
    const timer = setTimeout(async () => {
      const next = await adminPollJob(slug, latest.id);
      setClock(new Date());
      if (!next) {
        setError("The job could not be found. Refresh the page.");
        return;
      }
      setLatest(next);
      if (next.status === "done") setDone(next);
      if (!jobActive(next.status)) waitStart.current = null;
      else if (
        nextPollDelayMs(next.status, performance.now() - (waitStart.current ?? 0)) === null
      ) {
        setGaveUp(true);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [latest, slug]);

  const run = () =>
    start(async () => {
      setError(null);
      setGaveUp(false);
      const res = await adminRunDiagnostic(
        slug,
        kind === "logs" ? { type: "fetch_logs", tail } : { type: "inspect_workspace" },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      waitStart.current = performance.now();
      // The job row is not loaded yet; a placeholder makes the poll effect pick it up by id.
      setClock(new Date());
      setLatest({
        id: res.data.jobId,
        type: kind === "logs" ? "fetch_logs" : "inspect_workspace",
        status: "queued",
        attempts: 0,
        lastError: null,
        result: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
    });

  const label = kind === "logs" ? "Fetch logs" : "Refresh processes";
  const failed = latest?.status === "failed" ? latest : null;

  let body: React.ReactNode = null;
  let fetchedAt: string | null = null;
  if (done && kind === "logs") {
    const r = fetchLogsResultSchema.safeParse(done.result);
    if (r.success) {
      fetchedAt = r.data.fetchedAt;
      body = (
        <CodeBlock
          label="Workspace logs"
          text={r.data.log === "" ? "The workspace has written no logs yet." : r.data.log}
          maxHeight="32rem"
        />
      );
    }
  } else if (done) {
    const r = inspectWorkspaceResultSchema.safeParse(done.result);
    if (r.success) {
      fetchedAt = r.data.fetchedAt;
      body = (
        <CodeBlock
          label="Process list"
          text={formatProcessTable(r.data.processes)}
          maxHeight="32rem"
        />
      );
    }
  }
  const ageDate = fetchedAt ? new Date(fetchedAt) : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {kind === "logs" ? (
          <div className="flex gap-1.5" role="group" aria-label="Lines to fetch">
            {LOG_TAILS.map((n) => (
              <Button
                key={n}
                size="sm"
                variant={tail === n ? "secondary" : "outline"}
                aria-pressed={tail === n}
                onClick={() => setTail(n)}
              >
                Last {n}
              </Button>
            ))}
          </div>
        ) : null}
        <Button size="sm" onClick={run} disabled={!running || pending || (active && !gaveUp)}>
          {active && !gaveUp ? "Waiting for the worker" : label}
        </Button>
        {ageDate ? (
          <span className="text-meta text-muted-foreground">
            Fetched {formatAgo(ageDate, clock)} ({formatDateTime(ageDate)})
          </span>
        ) : null}
      </div>

      {!running ? (
        <Notice>
          This workspace is not running, so there is nothing live to read. Start it from the Manage
          tab. The last result stays below.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {failed ? (
        <Notice tone="error">
          The last request failed{failed.lastError ? `: ${failed.lastError}` : ""}. Check that the
          workspace is running, then try again.
        </Notice>
      ) : null}
      {gaveUp ? (
        <Notice>
          Still queued after two minutes. The worker may be busy or down; check System, then refresh
          this page to see the result when it lands.
        </Notice>
      ) : null}

      {body ?? (
        <p className="rounded-lg border border-dashed px-5 py-8 text-sm text-muted-foreground">
          {kind === "logs"
            ? "No logs fetched yet. Choose how many lines and press Fetch logs."
            : "No process list yet. Press Refresh processes to read it from the workspace."}
        </p>
      )}
    </div>
  );
}
