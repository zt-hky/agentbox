"use client";

import { cn } from "@/lib/utils";

/** A radio group drawn as bordered cards with a title and a one-line explanation each. */
export function ChoiceCards<T extends string | boolean>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string;
  legend: string;
  options: ReadonlyArray<{ value: T; title: string; detail: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map((o) => (
        <label
          key={String(o.value)}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5",
            value === o.value ? "border-signal" : "hover:border-foreground/30",
          )}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-1 accent-primary"
          />
          <span>
            <span className="block text-sm font-medium">{o.title}</span>
            <span className="block text-meta text-muted-foreground">{o.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
