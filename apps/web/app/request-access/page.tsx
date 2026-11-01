import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/auth-shell";
import { Notice } from "@/components/notice";
import { signOut } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import { latestRequestFor } from "@/lib/queries";
import { baseDomain } from "@/lib/env";
import { db } from "@agentbox/db/client";
import { suggestAvailableSlug } from "@/lib/slug-taken";
import { requireUser } from "@/lib/session";
import { ApprovalWatcher, RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Waiting for access" };

type StepState = "done" | "current" | "todo";

function Step({ state, title, detail }: { state: StepState; title: string; detail?: string }) {
  return (
    <li className="group relative flex gap-3 pb-5 last:pb-0">
      <span className="relative flex w-5 shrink-0 justify-center">
        <span
          className="absolute top-6 -bottom-1 w-px bg-border group-last:hidden"
          aria-hidden="true"
        />
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-5 items-center justify-center rounded-full border",
            state === "done" && "border-signal bg-signal text-signal-foreground",
            state === "current" && "border-status-busy",
            state === "todo" && "border-border",
          )}
        >
          {state === "done" ? <Check className="size-3" /> : null}
          {state === "current" ? <span className="size-2 rounded-full bg-status-busy" /> : null}
        </span>
      </span>
      <div>
        <div className={cn("text-sm font-medium", state === "todo" && "text-muted-foreground")}>
          {title}
          <span className="sr-only">
            {state === "done" ? " (done)" : state === "current" ? " (in progress)" : ""}
          </span>
        </div>
        {detail ? <div className="text-meta text-muted-foreground">{detail}</div> : null}
      </div>
    </li>
  );
}

const formatWhen = (d: Date) =>
  d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

export default async function RequestAccessPage() {
  const session = await requireUser();
  const status = session.user.accessStatus;
  if (status === "active") redirect("/");
  const latest = await latestRequestFor(session.user.id);
  const initialSlug =
    latest?.status === "pending" && latest.requestedSlug
      ? latest.requestedSlug
      : await suggestAvailableSlug(db, { email: session.user.email, userId: session.user.id });
  const domain = baseDomain();
  const firstName = session.user.name.split(" ")[0] || session.user.name;

  const headings: Record<string, { title: string; text: string }> = {
    pending: {
      title: "Your request is waiting for approval",
      text: "An administrator reviews every new account before you can set up a workspace. You do not need to do anything else; this page checks every 30 seconds and moves on once you are approved.",
    },
    none: {
      title: "Request access",
      text: "Send a request and an administrator will review it.",
    },
    rejected: {
      title: "Your request was not approved",
      text: "You can send a new request with more details.",
    },
    suspended: {
      title: "Your access is suspended",
      text: "An administrator has paused this account. Contact them if you think this is a mistake.",
    },
  };
  const heading = headings[status ?? "none"] ?? headings.none!;

  return (
    <AuthShell>
      <div className="space-y-1.5">
        <h1 className="text-title">{heading.title}</h1>
        <p className="text-sm text-muted-foreground">
          Hi {firstName}. {heading.text}
        </p>
      </div>

      {status === "pending" ? (
        <ol>
          <Step state="done" title="Signed in" detail={session.user.email} />
          <Step
            state="current"
            title="Admin review"
            detail={latest ? `Requested ${formatWhen(latest.createdAt)}` : undefined}
          />
          <Step
            state="todo"
            title="Workspace ready"
            detail="K-code and VS Code open from your dashboard."
          />
        </ol>
      ) : null}

      {status === "rejected" && latest?.reason ? (
        <Notice tone="error">
          <span className="font-medium">Reason from the admin: </span>
          {latest.reason}
        </Notice>
      ) : null}

      {status === "pending" ? (
        <RequestForm
          mode="note"
          initialMessage={latest?.message ?? ""}
          initialSlug={initialSlug}
          baseDomain={domain}
        />
      ) : null}
      {status === "none" ? (
        <RequestForm mode="request" initialSlug={initialSlug} baseDomain={domain} />
      ) : null}
      {status === "rejected" ? (
        <RequestForm mode="again" initialSlug={initialSlug} baseDomain={domain} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <span className="text-meta text-muted-foreground">Signed in as {session.user.email}</span>
        <div className="flex items-center gap-1">
          {status === "pending" ? <ApprovalWatcher /> : null}
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </AuthShell>
  );
}
