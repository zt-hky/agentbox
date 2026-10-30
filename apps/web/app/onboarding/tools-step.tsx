"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { REGISTRY_TOOL_LIMIT, type ToolId } from "@agentbox/core/toolchain";
import { Notice } from "@/components/notice";
import { RegistrySearch } from "@/components/registry-search";
import { RegistryVersion } from "@/components/registry-version";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/lib/action";
import type {
  OnboardingManagerOption,
  OnboardingRegistryPick,
  OnboardingRuntimeOption,
  OnboardingVersionChoice,
} from "@/lib/onboarding";
import { parseChannelValue } from "@/lib/toolchain/version-options";
import { cn } from "@/lib/utils";

/** The version value each picked tool holds: `latest`, `lts` or `pin:<line>`. */
export type VersionValues = Partial<Record<ToolId, string>>;

export interface ToolSelectionPayload {
  toolIds: ToolId[];
  versions: Partial<
    Record<ToolId, { channel: "latest" | "lts" | "pin"; pinnedVersion: string | null }>
  >;
}

function VersionSelect({
  label,
  choice,
  value,
  onChange,
  disabled,
}: {
  label: string;
  choice: OnboardingVersionChoice;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className="w-48" aria-label={`${label} version`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choice.options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One row: checkbox, name and description on the left, the version select on the right. */
function ToolRow({
  tool,
  on,
  onToggle,
  choice,
  value,
  onVersion,
  index,
  disabled,
}: {
  tool: OnboardingRuntimeOption | OnboardingManagerOption;
  on: boolean;
  onToggle: (on: boolean) => void;
  choice: OnboardingVersionChoice;
  value: string;
  onVersion: (value: string) => void;
  index: number;
  disabled: boolean;
}) {
  return (
    <li
      className={cn(
        "chain-reveal flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border bg-card px-4 py-3 transition-colors",
        on ? "border-signal" : "hover:border-foreground/30",
      )}
      style={{ "--i": index } as React.CSSProperties}
    >
      <label className="flex min-w-0 flex-1 basis-56 cursor-pointer items-start gap-3">
        <Checkbox
          checked={on}
          onCheckedChange={(v) => onToggle(v === true)}
          disabled={disabled}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{tool.label}</span>
            {tool.sizeHintMb === null ? null : (
              <span className="font-mono text-xs text-muted-foreground">~{tool.sizeHintMb} MB</span>
            )}
          </span>
          <span className="mt-0.5 block text-meta text-muted-foreground">{tool.description}</span>
        </span>
      </label>
      {on ? (
        <VersionSelect
          label={tool.label}
          choice={choice}
          value={value}
          onChange={onVersion}
          disabled={disabled}
        />
      ) : null}
    </li>
  );
}

/**
 * Step 1 in two ordered parts. 1a: languages, each with a version select. 1b: the package managers
 * of the chosen languages, each with a version select; the ones a language ships with are listed as
 * included. Nothing is saved until the second part continues, so going back loses nothing.
 */
export function ToolsStep({
  tools,
  toolIds,
  managerIds,
  registry,
  versions,
  onToolIdsChange,
  onManagerIdsChange,
  onRegistryChange,
  onVersionsChange,
  save,
  onDone,
}: {
  tools: OnboardingRuntimeOption[];
  toolIds: ToolId[];
  managerIds: ToolId[];
  registry: OnboardingRegistryPick[];
  versions: VersionValues;
  onToolIdsChange: (ids: ToolId[]) => void;
  onManagerIdsChange: (ids: ToolId[]) => void;
  onRegistryChange: (picks: OnboardingRegistryPick[]) => void;
  onVersionsChange: (versions: VersionValues) => void;
  save: (payload: ToolSelectionPayload) => Promise<ActionResult<void>>;
  onDone: () => void;
}) {
  const [part, setPart] = useState<"languages" | "managers">("languages");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const picked = tools.filter((t) => toolIds.includes(t.toolId));
  const valueOf = (t: { toolId: ToolId; version: OnboardingVersionChoice }) =>
    versions[t.toolId] ?? t.version.value;
  const setVersion = (id: ToolId, value: string) => onVersionsChange({ ...versions, [id]: value });

  const toggleLanguage = (language: OnboardingRuntimeOption, on: boolean) => {
    onToolIdsChange(
      on ? [...toolIds, language.toolId] : toolIds.filter((x) => x !== language.toolId),
    );
    if (!on) {
      // A language's package managers go with it.
      const gone = new Set<ToolId>(language.managers.map((m) => m.toolId));
      onManagerIdsChange(managerIds.filter((x) => !gone.has(x)));
    }
  };
  const toggleManager = (id: ToolId, on: boolean) =>
    onManagerIdsChange(on ? [...managerIds, id] : managerIds.filter((x) => x !== id));

  // Registry tools are saved with the languages; a typed version must be filled in first.
  const registryError = () => {
    const empty = registry.find((r) => r.value.startsWith("pin:") && r.value.length <= 4);
    return empty ? `Enter a version for ${empty.name}, or choose Latest.` : null;
  };
  const continueToManagers = () => {
    const problem = registryError();
    setError(problem);
    if (!problem) setPart("managers");
  };

  const submit = () =>
    start(async () => {
      setError(null);
      const keptManagers = picked.flatMap((t) =>
        t.managers.filter((m) => managerIds.includes(m.toolId)),
      );
      const chosen = [...picked, ...keptManagers];
      const payload: ToolSelectionPayload = {
        toolIds: [...chosen.map((t) => t.toolId), ...registry.map((r) => r.toolId)],
        versions: {
          ...Object.fromEntries(chosen.map((t) => [t.toolId, parseChannelValue(valueOf(t))])),
          ...Object.fromEntries(registry.map((r) => [r.toolId, parseChannelValue(r.value)])),
        },
      };
      const res = await save(payload);
      if (res.ok) onDone();
      else setError(res.error);
    });

  const totalMb = [
    ...picked,
    ...picked.flatMap((t) => t.managers.filter((m) => managerIds.includes(m.toolId))),
  ].reduce((sum, t) => sum + (t.sizeHintMb ?? 0), 0);

  if (part === "languages") {
    return (
      <section className="space-y-5">
        <div>
          <h2 className="text-xl">Choose your languages and versions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Step 1 of 2. Installed into your workspace after it is created. Pick only what you need;
            each one is a download. Each follows the version you choose until you change it.
          </p>
        </div>
        <ul className="grid gap-2">
          {tools.map((t, i) => (
            <ToolRow
              key={t.toolId}
              tool={t}
              on={toolIds.includes(t.toolId)}
              onToggle={(on) => toggleLanguage(t, on)}
              choice={t.version}
              value={valueOf(t)}
              onVersion={(v) => setVersion(t.toolId, v)}
              index={i}
              disabled={pending}
            />
          ))}
        </ul>
        {registry.length > 0 ? (
          <ul className="grid gap-2" aria-label="Tools from the mise registry">
            {registry.map((r, i) => (
              <li
                key={r.toolId}
                className="chain-reveal flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-signal bg-card px-4 py-3"
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className="min-w-0 flex-1 basis-56">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge variant="status" className="font-mono">
                      {r.backend}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-meta text-muted-foreground">
                    {r.description || "From the mise registry."}
                  </span>
                </span>
                <RegistryVersion
                  toolId={r.toolId}
                  label={r.name}
                  value={r.value}
                  disabled={pending}
                  onChange={(value) =>
                    onRegistryChange(
                      registry.map((x) => (x.toolId === r.toolId ? { ...x, value } : x)),
                    )
                  }
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Remove ${r.name}`}
                  disabled={pending}
                  onClick={() => onRegistryChange(registry.filter((x) => x.toolId !== r.toolId))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {registry.length < REGISTRY_TOOL_LIMIT ? (
          <RegistrySearch
            exclude={registry.map((r) => r.toolId)}
            disabled={pending}
            onPick={(hit) =>
              onRegistryChange([
                ...registry,
                {
                  toolId: hit.id,
                  name: hit.name,
                  description: hit.description,
                  backend: hit.backend,
                  value: "latest",
                },
              ])
            }
          />
        ) : null}
        <p className="text-sm text-muted-foreground">
          {picked.length + registry.length === 0
            ? "No language is selected. You can add them later under Tools."
            : `${picked.length + registry.length} selected.`}
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex gap-2">
          <Button onClick={continueToManagers}>Continue</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl">Choose your package managers</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Step 2 of 2. Package managers for the languages you picked. Some come with the language
          and need nothing extra.
        </p>
      </div>
      {picked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No language is selected, so there are no package managers to set up. Go back to pick one,
          or continue and add tools later.
        </p>
      ) : (
        picked.map((t) => (
          <div key={t.toolId} className="space-y-2">
            <h3 className="text-sm">{t.label}</h3>
            <ul className="grid gap-2">
              {t.bundled.map((b) => (
                <li
                  key={b.name}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{b.name}</span>
                    <span className="block text-meta text-muted-foreground">{b.detail}</span>
                  </span>
                  <Badge variant="status">Included</Badge>
                </li>
              ))}
              {t.managers.map((m, i) => (
                <ToolRow
                  key={m.toolId}
                  tool={m}
                  on={managerIds.includes(m.toolId)}
                  onToggle={(on) => toggleManager(m.toolId, on)}
                  choice={m.version}
                  value={valueOf(m)}
                  onVersion={(v) => setVersion(m.toolId, v)}
                  index={i}
                  disabled={pending}
                />
              ))}
            </ul>
          </div>
        ))
      )}
      <p className="text-sm text-muted-foreground">
        {picked.length} language{picked.length === 1 ? "" : "s"}, about {totalMb} MB of disk.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={() => setPart("languages")}>
          Back
        </Button>
        <Button disabled={pending} onClick={submit}>
          {pending ? "Saving" : "Continue"}
        </Button>
      </div>
    </section>
  );
}
