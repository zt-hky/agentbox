"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { GitAccounts } from "@/components/git-accounts";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OnboardingAgentOption, OnboardingState } from "@/lib/onboarding";
import { removeAgentKeyAction, saveAgentKeyAction } from "./actions";

function KeyField({
  agent,
  credential,
  initialMasked,
}: {
  agent: OnboardingAgentOption;
  credential: OnboardingAgentOption["credentials"][number];
  initialMasked: string | null;
}) {
  const [masked, setMasked] = useState(initialMasked);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const id = `${agent.toolId}-${credential.envVar}`;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{credential.label}</Label>
      {masked ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm">
            <Check className="size-4 text-status-ok" aria-hidden />
            Saved <Mono>{masked}</Mono>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await removeAgentKeyAction({
                  agentId: agent.toolId,
                  envVar: credential.envVar,
                });
                if (res.ok) setMasked(null);
                else setError(res.error);
              })
            }
          >
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            start(async () => {
              setError(null);
              const res = await saveAgentKeyAction({
                agentId: agent.toolId,
                envVar: credential.envVar,
                value: value.trim(),
              });
              if (res.ok) {
                setMasked(res.data.masked);
                setValue("");
              } else setError(res.error);
            });
          }}
        >
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={credential.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={pending || !value.trim()}>
            Save
          </Button>
        </form>
      )}
      <p className="text-meta text-muted-foreground">{credential.hint}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

/** Step 3: git hosts and per-agent credentials. Everything here is skippable. */
export function AccountsStep({
  git,
  gitError,
  gitConnected,
  agents,
  onBack,
  onNext,
}: {
  git: OnboardingState["git"];
  gitError: string | null;
  gitConnected: string | null;
  agents: OnboardingAgentOption[];
  onBack: () => void;
  onNext: () => void;
}) {
  const withKeys = agents.filter((a) => a.credentials.length > 0);
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-xl">Sign in your accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Keys are stored encrypted and written into your workspace as{" "}
          <Mono>~/.agentbox/secrets.env</Mono>, readable only by you. Skip anything you want to do
          later.
        </p>
      </div>

      <div className="space-y-2">
        <div>
          <h3 className="text-base">Git hosts</h3>
          <p className="text-meta text-muted-foreground">
            Clone, pull and push over HTTPS and SSH without more setup. Connect GitHub, GitLab,
            Bitbucket or your own host.
          </p>
        </div>
        <GitAccounts view={git} next="onboarding" error={gitError} connected={gitConnected} />
      </div>

      {withKeys.map((agent) => (
        <div key={agent.toolId} className="space-y-4 rounded-lg border bg-card p-5">
          <div>
            <h3 className="text-base">{agent.label}</h3>
            <p className="text-meta text-muted-foreground">{agent.description}</p>
          </div>
          {agent.credentials.map((c) => (
            <KeyField
              key={c.envVar}
              agent={agent}
              credential={c}
              initialMasked={agent.saved.find((s) => s.envVar === c.envVar)?.masked ?? null}
            />
          ))}
        </div>
      ))}
      {withKeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None of the agents you chose need a pasted key. Sign them in from a terminal after the
          workspace is ready.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Create workspace</Button>
      </div>
    </section>
  );
}
