import type { Metadata } from "next";
import { db } from "@agentbox/db/client";
import { EmptyState } from "@/components/empty-state";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { formatAgo } from "@/lib/format";
import { requireActiveUser } from "@/lib/session";
import { loadToolsView } from "@/lib/toolchain/view";
import { HeaderActions } from "./header-actions";
import { RunPanel } from "./run-panel";
import { ToolsTable } from "./tools-table";

export const metadata: Metadata = { title: "Tools" };
export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  const { user } = await requireActiveUser();
  const view = await loadToolsView(db, user.id);
  if (!view) {
    return (
      <>
        <PageHeader title="Tools" description="Runtimes and agent CLIs inside your workspace." />
        <EmptyState
          title="No workspace yet"
          description="Tools are installed in your workspace. Once it is provisioned they appear here."
        />
      </>
    );
  }

  const { workspace, tools, run } = view;
  const asleep = workspace.status !== "running" && workspace.status !== "starting";
  const runtimes = tools.filter((t) => t.kind === "runtime");
  const managers = tools.filter((t) => t.kind === "package-manager");
  const agents = tools.filter((t) => t.kind === "agent");
  const upgradable = tools.filter((t) => t.canUpgrade).length;
  const failed = tools.some((t) => t.state === "failed" && t.desired);
  const inProgress = run?.open ? run : null;

  return (
    <>
      <PageHeader
        title="Tools"
        description="Runtimes and agent CLIs inside your workspace. Each follows a channel you choose and is changed only when you ask."
        actions={<HeaderActions upgradable={upgradable} asleep={asleep} />}
      />

      {asleep ? (
        <Notice>
          Your workspace is asleep. Applying a change starts it, billed as normal awake time, and
          the idle policy stops it again afterwards.
        </Notice>
      ) : null}
      {workspace.pending ? (
        <Notice>
          A change is waiting for the workspace to start. It is applied as soon as the workspace is
          running.
        </Notice>
      ) : null}
      {inProgress ? (
        <Notice>
          {inProgress.progress.total > 0
            ? `A run is in progress: ${inProgress.progress.done} of ${inProgress.progress.total} steps finished.`
            : "A run is queued and waiting for its plan."}
        </Notice>
      ) : null}
      {view.latestErrors.length > 0 ? (
        <Notice tone="error">
          Could not check the latest versions of {view.latestErrors.map((e) => e.toolId).join(", ")}
          . Versions shown come from the last successful check.
        </Notice>
      ) : null}

      <Section
        title="Runtimes"
        description={`Versions last checked ${view.latestCheckedAt ? formatAgo(new Date(view.latestCheckedAt)) : "never"}.`}
        bodyClassName="p-0"
      >
        <ToolsTable tools={runtimes} asleep={asleep} empty="No runtimes are available." />
      </Section>
      <Section
        title="Package managers"
        description="Each installs on top of its language and needs that language installed first. npm, pip, Cargo and Go modules come with their language."
        bodyClassName="p-0"
      >
        <ToolsTable tools={managers} asleep={asleep} empty="No package managers are available." />
      </Section>
      <Section title="Agent CLIs" bodyClassName="p-0">
        <ToolsTable tools={agents} asleep={asleep} empty="No agent CLIs are available." />
      </Section>
      <p className="max-w-prose text-sm text-muted-foreground">
        Installed tools are linked into <Mono>~/.agentbox/bin</Mono>, which is first on{" "}
        <Mono>PATH</Mono>. T3 Code and your terminal pick them up from there automatically.
      </p>

      <RunPanel initialRun={run} initialHistory={view.history} canRetry={failed} />
    </>
  );
}
