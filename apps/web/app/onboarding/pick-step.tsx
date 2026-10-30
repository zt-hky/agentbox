"use client";

import { useState, useTransition } from "react";
import type { ToolId } from "@agentbox/core/toolchain";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { ActionResult } from "@/lib/action";
import type { OnboardingToolOption } from "@/lib/onboarding";

/** Step 1 and 2: pick tools from a list. Saved on continue. */
export function PickStep({
  title,
  description,
  options,
  selected,
  onSelectedChange,
  save,
  onDone,
  onBack,
  nextLabel,
  emptyHint,
}: {
  title: string;
  description: string;
  options: OnboardingToolOption[];
  selected: ToolId[];
  onSelectedChange: (ids: ToolId[]) => void;
  save: (ids: ToolId[]) => Promise<ActionResult<void>>;
  onDone: () => void;
  onBack?: () => void;
  nextLabel: string;
  emptyHint: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: ToolId, on: boolean) =>
    onSelectedChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const totalMb = options
    .filter((o) => selected.includes(o.toolId))
    .reduce((sum, o) => sum + (o.sizeHintMb ?? 0), 0);

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {options.map((o, i) => {
          const on = selected.includes(o.toolId);
          return (
            <li key={o.toolId} className="chain-reveal" style={{ "--i": i } as React.CSSProperties}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-card px-4 py-3 transition-colors ${
                  on ? "border-signal" : "hover:border-foreground/30"
                }`}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => toggle(o.toolId, v === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {o.sizeHintMb === null ? "" : `~${o.sizeHintMb} MB`}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-meta text-muted-foreground">
                    {o.description}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {selected.length} selected, about {totalMb} MB of disk.
        </p>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        {onBack ? (
          <Button variant="outline" disabled={pending} onClick={onBack}>
            Back
          </Button>
        ) : null}
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await save(selected);
              if (res.ok) onDone();
              else setError(res.error);
            })
          }
        >
          {pending ? "Saving" : nextLabel}
        </Button>
      </div>
    </section>
  );
}
