import type { Metadata } from "next";
import { GitAccounts } from "@/components/git-accounts";
import { KeyValueList } from "@/components/key-value-list";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { db } from "@agentbox/db/client";
import { getCopilotView } from "@/lib/accounts";
import { loadGitAccountsView } from "@/lib/git-accounts";
import { requireActiveUser } from "@/lib/session";
import { CopilotPanel } from "./copilot-panel";

export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const { user } = await requireActiveUser();
  const { error, connected } = await searchParams;
  const view = await loadGitAccountsView(db, user.id);
  const { workspaceStatus, copilot } = await getCopilotView(db, user.id);
  const hasGithub = view.connections.some((c) => c.provider === "github");

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Git hosts for clone, pull and push over HTTPS and SSH, Copilot for the Copilot CLI and T3, and what to expect in VS Code."
      />
      <div className="max-w-3xl space-y-4">
        <GitAccounts view={view} next="settings" error={error} connected={connected} />

        {hasGithub ? (
          <Section
            title="GitHub Copilot"
            description="Copilot CLI signs in with its own GitHub device code and needs an active Copilot plan. Once signed in it appears in T3 as a provider."
          >
            <CopilotPanel initial={copilot} workspaceRunning={workspaceStatus === "running"} />
          </Section>
        ) : null}

        <Section
          title="VS Code in the browser"
          description="What works in the code-server editor, and what does not."
        >
          <KeyValueList
            items={[
              {
                label: "Git in the editor",
                value:
                  "Clone, pull and push work without signing in to VS Code. They use the git accounts connected above, over HTTPS or SSH.",
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
