"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CodeBlock } from "@/components/code-block";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { RunView } from "@/lib/toolchain/view";
import { pollRunAction, retryFailedAction } from "./actions";
import { useToolAction } from "./use-tool-action";

const POLL_MS = 2000;

const h = columnHelper<RunView>();
const historyColumns = [
  h.accessor("createdAt", {
    header: "Started",
    cell: (c) => `${c.getValue().slice(0, 16).replace("T", " ")} UTC`,
  }),
  h.accessor("trigger", { header: "Trigger" }),
  h.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} /> }),
  h.display({
    id: "steps",
    header: "Steps",
    cell: (c) => {
      const p = c.row.original.progress;
      return p.total === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        `${p.done} of ${p.total}`
      );
    },
  }),
  h.accessor("error", {
    header: "Error",
    cell: (c) =>
      c.getValue() ? (
        <span className="line-clamp-2 max-w-md whitespace-normal text-destructive">
          {c.getValue()}
        </span>
      ) : (
        <span className="text-muted-foreground">none</span>
      ),
  }),
] as Columns<RunView>;

const STEP_LABEL: Record<string, string> = {
  ok: "Done",
  running: "Running",
  failed: "Failed",
  skipped: "Skipped",
};

function stepLine(s: RunView["steps"][number]): string {
  const target = s.version ? ` ${s.version}` : "";
  const err = s.status === "failed" && s.error ? `: ${s.error}` : "";
  return `${s.tool} ${s.action}${target}${err}`;
}

export function RunPanel({
  initialRun,
  initialHistory,
  canRetry,
}: {
  initialRun: RunView | null;
  initialHistory: RunView[];
  canRetry: boolean;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [history, setHistory] = useState(initialHistory);
  const { pending, run: act } = useToolAction();
  const wasOpen = useRef(initialRun?.open ?? false);

  useEffect(() => {
    setRun(initialRun);
    setHistory(initialHistory);
  }, [initialRun, initialHistory]);

  const open = run?.open ?? false;
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false;
        router.refresh();
      }
      return;
    }
    wasOpen.current = true;
    let stopped = false;
    const id = setInterval(async () => {
      const res = await pollRunAction();
      if (stopped || !res.ok || !res.data) return;
      setRun(res.data.run);
      setHistory(res.data.history);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [open, router]);

  const failed = !!run && ["failed", "partial", "interrupted"].includes(run.status);
  return (
    <Section
      title="Run"
      description="Installs, upgrades and removals run inside your workspace as one run at a time."
      actions={
        canRetry || failed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => act(retryFailedAction, "Retry queued")}
          >
            Retry failed
          </Button>
        ) : null
      }
    >
      {run ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={run.status} />
            <span className="text-sm text-muted-foreground">
              {run.progress.total > 0
                ? `${run.progress.done} of ${run.progress.total} steps finished`
                : run.open
                  ? "Waiting for the plan"
                  : "No steps were needed"}
            </span>
          </div>
          {run.error ? <p className="text-sm text-destructive">{run.error}</p> : null}
          {run.steps.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {run.steps.map((s, i) => (
                <li key={`${s.tool}-${s.action}-${i}`} className="flex items-center gap-2">
                  <StatusBadge
                    status={
                      s.status === "ok" ? "done" : s.status === "running" ? "pending" : s.status
                    }
                    label={STEP_LABEL[s.status]}
                  />
                  <Mono>{stepLine(s)}</Mono>
                </li>
              ))}
            </ul>
          ) : null}
          {run.logTail ? (
            <CodeBlock text={run.logTail} label="Run log" maxHeight="17.5rem" />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No runs yet. Installing or upgrading a tool starts one.
        </p>
      )}
      {history.length > 0 ? (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-medium">Recent runs</h3>
          <DataTable columns={historyColumns} data={history} />
        </div>
      ) : null}
    </Section>
  );
}
