import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Box } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signOut } from "@/app/login/actions";
import { latestRequestFor } from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Request access" };

export default async function RequestAccessPage() {
  const session = await requireUser();
  const status = session.user.accessStatus;
  if (status === "active") redirect("/");
  const latest = await latestRequestFor(session.user.id);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Box className="size-4" />
          </div>
          AgentBox
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Request access
              <Badge variant="secondary">{status}</Badge>
            </CardTitle>
            <CardDescription>Signed in as {session.user.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status === "pending" ? (
              <p className="text-sm text-muted-foreground">
                Your request was submitted
                {latest
                  ? ` on ${latest.createdAt.toLocaleDateString("en-US", { dateStyle: "long" })}`
                  : ""}
                . An administrator will review it; check back soon.
              </p>
            ) : null}
            {status === "suspended" ? (
              <p className="text-sm text-muted-foreground">
                Your account is suspended. Contact an administrator.
              </p>
            ) : null}
            {status === "rejected" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Your last request was rejected
                  {latest?.reason ? `: ${latest.reason}` : "."}
                </p>
                <RequestForm again />
              </>
            ) : null}
            {status === "none" ? <RequestForm again={false} /> : null}
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
