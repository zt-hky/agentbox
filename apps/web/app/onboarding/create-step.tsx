"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Chain, ChainBar, type ChainItem } from "@/components/chain";
import { HashTicker } from "@/components/hash-ticker";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import type { OnboardingProgress, OnboardingState } from "@/lib/onboarding";
import {
  finishOnboardingAction,
  pollOnboardingProgressAction,
  startWorkspaceCreationAction,
} from "./actions";

const POLL_MS = 1800;
const RETRY_DELETING_MS = 3000;

const STAGE_LABEL = {
  provision: { label: "Provision machine", detail: "Allocating disk, CPU and memory" },
  start: { label: "Start workspace", detail: "Booting K-code and VS Code" },
  tools: { label: "Install tools", detail: "Your languages and agents" },
} as const;

function lastLine(log: string): string {
  const lines = log.trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

/** Step 4: create the workspace and show provisioning, boot and tool install as a chain. */
export function CreateStep({
  slug,
  baseDomain,
  initialWorkspace,
  onBack,
}: {
  slug: string;
  baseDomain: string;
  initialWorkspace: OnboardingState["workspace"];
  onBack: () => void;
}) {
  const router = useRouter();
  const [started, setStarted] = useState(false);
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const finishing = useRef(false);
  const deleting = initialWorkspace?.status === "deleting";

  // Start (idempotent). While a previous workspace is still being deleted, retry until it is gone.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attemptStart = async () => {
      const res = await startWorkspaceCreationAction();
      if (cancelled) return;
      if (res.ok) {
        setError(null);
        setStarted(true);
      } else if (/delet/i.test(res.error)) {
        setError(null);
        timer = setTimeout(attemptStart, RETRY_DELETING_MS);
      } else {
        setError(res.error);
      }
    };
    void attemptStart();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt]);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    const res = await finishOnboardingAction();
    if (!res.ok) {
      finishing.current = false;
      setError(res.error);
      return;
    }
    setFinished(true);
    setTimeout(() => router.replace("/"), 1400);
  }, [router]);

  // Poll progress until the workspace is up and the toolchain settled.
  useEffect(() => {
    if (!started || finished) return;
    let stopped = false;
    const tick = async () => {
      const res = await pollOnboardingProgressAction();
      if (stopped) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setProgress(res.data);
      if (res.data.stage === "error") setError(res.data.error ?? "Workspace creation failed");
      else setError(null);
      if (res.data.canFinish) void finish();
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [started, finished, finish]);

  const failed = progress?.stage === "error";
  const active = started && !finished && !failed && progress?.stage !== "ready";

  const stageItems: ChainItem[] = (["provision", "start", "tools"] as const).map((id) => {
    const found = progress?.stages.find((s) => s.id === id);
    const state = finished
      ? "done"
      : (found?.state ?? (id === "provision" && started ? "active" : "pending"));
    return { key: id, ...STAGE_LABEL[id], state };
  });
  const toolItems: ChainItem[] = (progress?.tools ?? []).map((t) => ({
    key: `tool-${t.toolId}`,
    label: t.label,
    detail: t.version ?? (t.state === "installing" ? "Installing" : undefined),
    state:
      finished || t.state === "installed" || t.state === "external"
        ? "done"
        : t.state === "installing"
          ? "active"
          : t.state === "failed"
            ? "failed"
            : "pending",
  }));
  const doneCount = stageItems.filter((i) => i.state === "done").length;
  const log = progress ? lastLine(progress.logTail) : "";

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-xl">
          {finished ? "Your workspace is ready" : "Creating your workspace"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <Mono>
            {slug}.{baseDomain}
          </Mono>{" "}
          {finished
            ? "is awake. Taking you to the dashboard."
            : "is being built. This usually takes a few minutes; you can leave this page open."}
        </p>
      </div>

      <ChainBar
        value={finished ? 1 : doneCount / stageItems.length}
        active={active}
        label="Workspace creation progress"
      />
      <Chain items={stageItems} />

      {toolItems.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Tools</h3>
          <Chain items={toolItems} orientation="vertical" className="gap-0 [&>li]:flex-none" />
        </div>
      ) : null}

      <div className="flex items-center gap-3 rounded-md border bg-rack px-3 py-2 text-muted-foreground">
        <HashTicker active={active} length={24} settled={"0".repeat(24)} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {deleting && !started
            ? "Waiting for the previous workspace to finish deleting"
            : log || (started ? "Waiting for the workspace" : "Starting")}
        </span>
      </div>

      {error ? (
        <div className="space-y-3">
          <Notice tone="error">{error}</Notice>
          <div className="flex gap-2">
            {!started ? (
              <Button variant="outline" onClick={onBack}>
                Back
              </Button>
            ) : null}
            <Button
              onClick={() => {
                setError(null);
                finishing.current = false;
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
