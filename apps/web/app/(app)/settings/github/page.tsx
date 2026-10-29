import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { githubConnections } from "@agentbox/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { githubConnectConfig } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { requireActiveUser } from "@/lib/session";
import { DisconnectButton } from "./disconnect-button";

export const metadata: Metadata = { title: "GitHub" };

const ERRORS: Record<string, string> = {
  state: "The sign-in state did not match. Please try again.",
  exchange: "GitHub did not complete the connection. Please try again.",
};

export default async function GithubSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const { user } = await requireActiveUser();
  const { error, connected } = await searchParams;
  const rows = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.userId, user.id))
    .limit(1);
  const conn = rows[0];
  const configured = githubConnectConfig() !== null;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>GitHub connection</CardTitle>
        <CardDescription>
          Connects your workspace&apos;s gh CLI and git credentials to your GitHub account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {ERRORS[error] ?? "Connection failed."}
          </p>
        ) : null}
        {connected ? (
          <p className="text-sm text-muted-foreground">
            GitHub connected. Your workspace will pick it up shortly.
          </p>
        ) : null}
        {conn ? (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
              <dt className="text-muted-foreground">Account</dt>
              <dd>{conn.login}</dd>
              <dt className="text-muted-foreground">Scopes</dt>
              <dd>{conn.scopes || "none"}</dd>
              <dt className="text-muted-foreground">Connected</dt>
              <dd>{formatDateTime(conn.createdAt)}</dd>
            </dl>
            <DisconnectButton />
          </>
        ) : configured ? (
          <Button asChild>
            <a href="/api/github/connect">Connect GitHub</a>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            GitHub connection is not configured on this server.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
