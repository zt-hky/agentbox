import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Box, Check, Clock, Rocket, ShieldOff, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signOut } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import { latestRequestFor } from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { ApprovalWatcher, RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Waiting for access" };

type StepState = "done" | "current" | "todo";

function Step({
  state,
  icon: Icon,
  title,
  detail,
}: {
  state: StepState;
  icon: typeof Check;
  title: string;
  detail?: string;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border",
          state === "done" && "border-primary bg-primary text-primary-foreground",
          state === "current" && "border-primary text-primary",
          state === "todo" && "text-muted-foreground",
        )}
      >
        {state === "done" ? <Check className="size-4" /> : <Icon className="size-4" />}
      </span>
      <div className="pt-1">
        <div className={cn("text-sm font-medium", state === "todo" && "text-muted-foreground")}>
          {title}
        </div>
        {detail ? <div className="text-sm text-muted-foreground">{detail}</div> : null}
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
  const firstName = session.user.name.split(" ")[0] || session.user.name;

  const headings: Record<string, { icon: typeof Check; title: string; text: string }> = {
    pending: {
      icon: Clock,
      title: "Your request is waiting for approval",
      text: "An administrator reviews every new account before creating its workspace. You don't need to do anything else; this page updates by itself once you're approved.",
    },
    none: {
      icon: Clock,
      title: "Request access to AgentBox",
      text: "Send a request and an administrator will review it.",
    },
    rejected: {
      icon: XCircle,
      title: "Your request was not approved",
      text: "You can send a new request with more details.",
    },
    suspended: {
      icon: ShieldOff,
      title: "Your access is suspended",
      text: "An administrator has paused this account. Contact them if you think this is a mistake.",
    },
  };
  const heading = headings[status ?? "none"] ?? headings.none!;
  const HeadingIcon = heading.icon;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Box className="size-4" />
          </div>
          AgentBox
        </div>
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <HeadingIcon className="size-5" />
            </div>
            <CardTitle className="text-xl">
              Hi {firstName}. {heading.title}
            </CardTitle>
            <CardDescription>{heading.text}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {status === "pending" ? (
              <ol className="space-y-4">
                <Step state="done" icon={Check} title="Signed in" detail={session.user.email} />
                <Step
                  state="current"
                  icon={Clock}
                  title="Admin review"
                  detail={latest ? `Requested ${formatWhen(latest.createdAt)}` : undefined}
                />
                <Step
                  state="todo"
                  icon={Rocket}
                  title="Workspace ready"
                  detail="T3 Code and VS Code open from your dashboard"
                />
              </ol>
            ) : null}

            {status === "rejected" && latest?.reason ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div className="font-medium">Reason from the admin</div>
                <div className="text-muted-foreground">{latest.reason}</div>
              </div>
            ) : null}

            {status === "pending" ? (
              <RequestForm mode="note" initialMessage={latest?.message ?? ""} />
            ) : null}
            {status === "none" ? <RequestForm mode="request" /> : null}
            {status === "rejected" ? <RequestForm mode="again" /> : null}

            <div className="flex items-center justify-between border-t pt-4">
              <span className="text-xs text-muted-foreground">
                Signed in as {session.user.email}
              </span>
              <div className="flex items-center gap-1">
                {status === "pending" ? <ApprovalWatcher /> : null}
                <form action={signOut}>
                  <Button type="submit" variant="ghost" size="sm">
                    Sign out
                  </Button>
                </form>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
