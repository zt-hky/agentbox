"use client";

import { useState } from "react";
import { Chain, type ChainItem } from "@/components/chain";
import type { OnboardingState, OnboardingStep } from "@/lib/onboarding";
import { AccountsStep } from "./accounts-step";
import { CreateStep } from "./create-step";
import { PickStep } from "./pick-step";
import { ToolsStep, type VersionValues } from "./tools-step";
import { saveAgentSelectionAction, saveToolSelectionAction } from "./actions";
import type { ToolId } from "@agentbox/core/toolchain";

const STEPS: { id: OnboardingStep; label: string; detail: string }[] = [
  { id: "tools", label: "Languages", detail: "Versions and package managers" },
  { id: "agents", label: "Agents", detail: "Coding agent CLIs" },
  { id: "accounts", label: "Accounts", detail: "GitHub and API keys" },
  { id: "create", label: "Workspace", detail: "Build and install" },
];

export function Wizard({
  state,
  initialStep,
  githubError,
  githubJustConnected,
}: {
  state: OnboardingState;
  initialStep: OnboardingStep;
  githubError: string | null;
  githubJustConnected: boolean;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [toolIds, setToolIds] = useState<ToolId[]>(state.selectedToolIds);
  const [managerIds, setManagerIds] = useState<ToolId[]>(state.selectedManagerIds);
  const [versions, setVersions] = useState<VersionValues>({});
  const [agentIds, setAgentIds] = useState<ToolId[]>(state.selectedAgentIds);
  const current = STEPS.findIndex((s) => s.id === step);

  const items: ChainItem[] = STEPS.map((s, i) => ({
    key: s.id,
    label: s.label,
    detail: s.detail,
    state: i < current ? "done" : i === current ? "active" : "pending",
  }));

  return (
    <div className="space-y-8">
      <Chain items={items} />
      {step === "tools" ? (
        <ToolsStep
          key="tools"
          tools={state.tools}
          toolIds={toolIds}
          managerIds={managerIds}
          versions={versions}
          onToolIdsChange={setToolIds}
          onManagerIdsChange={setManagerIds}
          onVersionsChange={setVersions}
          save={saveToolSelectionAction}
          onDone={() => setStep("agents")}
        />
      ) : null}
      {step === "agents" ? (
        <PickStep
          key="agents"
          title="Choose your coding agents"
          description="Terminal agents that also show up in T3 Code. You sign them in on the next step."
          options={state.agents}
          selected={agentIds}
          onSelectedChange={setAgentIds}
          save={(ids) => saveAgentSelectionAction({ agentIds: ids })}
          onDone={() => setStep("accounts")}
          onBack={() => setStep("tools")}
          nextLabel="Continue"
          emptyHint="No agent is selected. You can add them later under Tools."
        />
      ) : null}
      {step === "accounts" ? (
        <AccountsStep
          github={state.github}
          githubError={githubError}
          githubJustConnected={githubJustConnected}
          agents={state.agents.filter((a) => agentIds.includes(a.toolId))}
          onBack={() => setStep("agents")}
          onNext={() => setStep("create")}
        />
      ) : null}
      {step === "create" ? (
        <CreateStep
          slug={state.slug.value}
          baseDomain={state.baseDomain}
          initialWorkspace={state.workspace}
          onBack={() => setStep("accounts")}
        />
      ) : null}
    </div>
  );
}
