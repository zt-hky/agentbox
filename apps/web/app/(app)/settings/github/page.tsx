import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { GITHUB_WORKFLOW_SCOPE, hasGithubScope } from "@agentbox/core/accounts";
import { db } from "@agentbox/db/client";
import { githubConnections } from "@agentbox/db/schema";
import { KeyValueList } from "@/components/key-value-list";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getCopilotView } from "@/lib/accounts";
import { githubConnectConfig } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { requireActiveUser } from "@/lib/session";
import { CopilotPanel } from "./copilot-panel";
import { DisconnectButton } from "./disconnect-button";

export const metadata: Metadata = { title: "Accounts" };

const ERRORS: Record<string, string> = {
  state: "GitHub sign-in expired or came from another browser tab. Start the connection again.",
  exchange: "GitHub did not finish the connection. Try again in a moment.",
};

export default async function AccountsPage({
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
  const { workspaceStatus, copilot } = await getCopilotView(db, user.id);
  const workflowAllowed = hasGithubScope(conn?.scopes, GITHUB_WORKFLOW_SCOPE);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="GitHub for git and the gh CLI, Copilot for the Copilot CLI and T3, and what to expect in VS Code."
      />
      <div className="max-w-2xl space-y-4">
        {error ? (
          <Notice tone="error">{ERRORS[error] ?? "The connection failed. Try again."}</Notice>
        ) : null}
        {connected ? (
          <Notice>GitHub is connected. Your workspace picks it up within a minute.</Notice>
        ) : null}
        {conn ? (
          <Section
            title="GitHub"
            actions={<StatusBadge status="active" label="Connected" />}
            description="git push and pull over HTTPS and the gh CLI use this account."
          >
            <KeyValueList
              items={[
                { label: "Account", value: <Mono>{conn.login}</Mono> },
                { label: "Scopes", value: conn.scopes ? <Mono>{conn.scopes}</Mono> : "None" },
                {
                  label: "Workflow files",
                  value: workflowAllowed ? (
                    "Pushes may change .github/workflows"
                  ) : (
                    <span className="flex flex-wrap items-center gap-3">
                      Pushes that change .github/workflows are rejected.
                      <Button asChild variant="outline" size="xs">
                        <a href="/api/github/connect?workflow=1">Allow editing workflows</a>
                      </Button>
                    </span>
                  ),
                },
                { label: "Connected on", value: formatDateTime(conn.createdAt) },
              ]}
            />
            <div className="mt-5 border-t pt-4">
              <DisconnectButton />
            </div>
          </Section>
        ) : configured ? (
          <Section
            title="GitHub"
            actions={<StatusBadge status="none" label="Not connected" />}
            description="git push and pull over HTTPS and the gh CLI use this account."
          >
            <p className="mb-4 text-sm text-muted-foreground">
              You will be sent to GitHub to approve repo, read:org and gist access, then brought
              back here. Editing workflow files is a separate opt-in after connecting.
            </p>
            <Button asChild>
              <a href="/api/github/connect">Connect GitHub</a>
            </Button>
          </Section>
        ) : (
          <Section title="GitHub" actions={<StatusBadge status="none" label="Not available" />}>
            <p className="text-sm text-muted-foreground">
              GitHub connection is not set up on this server. Ask an administrator to configure it
              in settings.
            </p>
          </Section>
        )}

        <Section
          title="GitHub Copilot"
          description="Copilot CLI signs in with its own GitHub device code and needs an active Copilot plan. Once signed in it appears in T3 as a provider."
        >
          <CopilotPanel initial={copilot} workspaceRunning={workspaceStatus === "running"} />
        </Section>

        <Section
          title="VS Code in the browser"
          description="What works in the code-server editor, and what does not."
        >
          <KeyValueList
            items={[
              {
                label: "Git in the editor",
                value:
                  "Clone, pull and push work without signing in to VS Code. They use the GitHub account connected above through the gh credential helper.",
              },
              {
                label: "GitHub account menu",
                value:
                  "Extensions such as GitHub Pull Requests ask you to sign in from the Accounts menu in VS Code. That sign-in cannot be preset from here. If the browser cannot return to the editor, copy the address it ends on and paste it into Command Palette → “Developer: Open URL”.",
              },
              {
                label: "Copilot Chat",
                value:
                  "Not available in this editor. Copilot extensions are not published on Open VSX, and the Microsoft Marketplace terms limit them to Microsoft products. Use Copilot in T3 or run copilot in the terminal.",
              },
            ]}
          />
        </Section>
      </div>
    </>
  );
}
