"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { COPILOT_DEVICE_URL, COPILOT_GRANT_SETTINGS_URL } from "@agentbox/core/accounts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { CopilotView } from "@/lib/accounts";
import { cancelOrSignOutCopilotAction, pollCopilotState, startCopilotLogin } from "./actions";

const POLL_MS = 2000;
const WATCHED: Record<string, true> = {
  starting: true,
  code: true,
  cancelling: true,
  signing_out: true,
};

/** Existing lamp statuses mapped to sign-in states, so the badge shows a word and a colour. */
const BADGE: Record<string, { status: string; label: string }> = {
  starting: { status: "starting", label: "Requesting code" },
  code: { status: "pending", label: "Waiting for you" },
  signed_in: { status: "active", label: "Signed in" },
  expired: { status: "failed", label: "Code expired" },
  failed: { status: "failed", label: "Failed" },
  cancelling: { status: "stopping", label: "Cancelling" },
  cancelled: { status: "none", label: "Cancelled" },
  signing_out: { status: "stopping", label: "Signing out" },
};

function remaining(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
}

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function CopilotPanel({
  initial,
  workspaceRunning,
}: {
  initial: CopilotView | null;
  workspaceRunning: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<CopilotView | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const status = view?.status ?? null;
  const watched = status !== null && WATCHED[status] === true;

  const refresh = useCallback(async () => {
    const res = await pollCopilotState();
    if (res.ok) setView(res.data);
  }, []);

  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current && prevStatus.current !== "signed_in" && status === "signed_in") {
      toast.success("Copilot signed in");
      router.refresh();
    }
    prevStatus.current = status;
  }, [status, router]);

  useEffect(() => {
    if (!watched) return;
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(poll);
  }, [watched, refresh]);

  useEffect(() => {
    if (status !== "code") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [status]);

  const begin = () =>
    start(async () => {
      setError(null);
      const res = await startCopilotLogin();
      if (res.ok) setView(res.data);
      else setError(res.error);
    });

  const stop = async () => {
    const res = await cancelOrSignOutCopilotAction();
    if (res.ok) {
      await refresh();
      router.refresh();
    }
    return res;
  };

  const left = status === "code" ? remaining(view?.detail.expiresAt, now) : null;
  const badge = status ? BADGE[status] : null;

  return (
    <div className="space-y-4">
      {badge ? (
        <div className="flex items-center gap-2 text-sm">
          <StatusBadge status={badge.status} label={badge.label} />
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {status === "failed" && view?.detail.error ? (
        <Notice tone="error">
          {view.detail.error}
          {/not installed/i.test(view.detail.error) ? (
            <>
              {" "}
              Install it from{" "}
              <Link href="/tools" className="underline">
                Tools
              </Link>
              .
            </>
          ) : null}
        </Notice>
      ) : null}
      {status === "expired" ? (
        <Notice>The code was not entered within 15 minutes. Request a new one.</Notice>
      ) : null}

      {status === "code" && view?.detail.userCode ? (
        <div className="space-y-3 rounded-lg border bg-rack p-4">
          <p className="text-sm text-muted-foreground">
            Enter this code at GitHub while signed in to the account that has Copilot.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="text-xl font-semibold tracking-widest">{view.detail.userCode}</Mono>
            <CopyButton text={view.detail.userCode} label="Copy code" />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button asChild size="sm">
              <a
                href={view.detail.verificationUri ?? COPILOT_DEVICE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open github.com/login/device
              </a>
            </Button>
            {left !== null ? (
              <span className="text-muted-foreground" aria-live="off">
                Expires in <Mono>{clock(left)}</Mono>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {status === "starting" ? (
        <p className="text-sm text-muted-foreground">Asking GitHub for a code in your workspace.</p>
      ) : null}

      {status === "signed_in" ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Copilot CLI is signed in inside your workspace and listed in K-code as the GitHub Copilot
            provider.
          </p>
          {view?.detail.providerError ? (
            <Notice tone="error">
              The K-code provider entry could not be written yet ({view.detail.providerError}). It is
              retried the next time the workspace syncs.
            </Notice>
          ) : null}
          <p>
            Signing out deletes the login from the workspace. GitHub keeps the authorization until
            you remove “GitHub Copilot CLI” under{" "}
            <a
              href={COPILOT_GRANT_SETTINGS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Settings → Applications → Authorized OAuth Apps
            </a>
            .
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {status === null ||
        status === "failed" ||
        status === "expired" ||
        status === "cancelled" ? (
          <Button onClick={begin} disabled={pending || !workspaceRunning}>
            Sign in to Copilot
          </Button>
        ) : null}
        {status === "starting" || status === "code" ? (
          <Button variant="outline" onClick={() => void stop()}>
            Cancel
          </Button>
        ) : null}
        {status === "signed_in" ? (
          <ConfirmDialog
            trigger={<Button variant="outline">Sign out of Copilot</Button>}
            title="Sign out of Copilot?"
            description="The Copilot login is deleted from your workspace and the Copilot provider is removed from K-code."
            confirmLabel="Sign out"
            destructive
            onConfirm={stop}
          />
        ) : null}
        {!workspaceRunning &&
        (status === null ||
          status === "failed" ||
          status === "expired" ||
          status === "cancelled") ? (
          <span className="text-sm text-muted-foreground">
            Your workspace is asleep. Open it first: the sign-in runs inside it.
          </span>
        ) : null}
      </div>
    </div>
  );
}
