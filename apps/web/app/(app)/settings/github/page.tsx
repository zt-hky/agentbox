import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { githubConnections } from "@agentbox/db/schema";
import { KeyValueList } from "@/components/key-value-list";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { githubConnectConfig } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { requireActiveUser } from "@/lib/session";
import { DisconnectButton } from "./disconnect-button";

export const metadata: Metadata = { title: "GitHub" };

const ERRORS: Record<string, string> = {
  state: "GitHub sign-in expired or came from another browser tab. Start the connection again.",
  exchange: "GitHub did not finish the connection. Try again in a moment.",
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
    <>
      <PageHeader
        title="GitHub"
        description="Connect your account so git and the gh CLI inside your workspace can reach your repositories."
      />
      <div className="max-w-2xl space-y-4">
        {error ? (
          <Notice tone="error">{ERRORS[error] ?? "The connection failed. Try again."}</Notice>
        ) : null}
        {connected ? (
          <Notice>GitHub is connected. Your workspace picks it up within a minute.</Notice>
        ) : null}
        {conn ? (
          <Section title="Connected" actions={<StatusBadge status="active" label="Connected" />}>
            <KeyValueList
              items={[
                { label: "Account", value: <Mono>{conn.login}</Mono> },
                { label: "Scopes", value: conn.scopes ? <Mono>{conn.scopes}</Mono> : "None" },
                { label: "Connected on", value: formatDateTime(conn.createdAt) },
              ]}
            />
            <div className="mt-5 border-t pt-4">
              <DisconnectButton />
            </div>
          </Section>
        ) : configured ? (
          <Section title="Not connected">
            <p className="mb-4 text-sm text-muted-foreground">
              You will be sent to GitHub to approve access, then brought back here.
            </p>
            <Button asChild>
              <a href="/api/github/connect">Connect GitHub</a>
            </Button>
          </Section>
        ) : (
          <Section title="Not available">
            <p className="text-sm text-muted-foreground">
              GitHub connection is not set up on this server. Ask an administrator to configure it
              in settings.
            </p>
          </Section>
        )}
      </div>
    </>
  );
}
