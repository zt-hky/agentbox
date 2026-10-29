import { cn } from "@/lib/utils";

export interface KeyValueItem {
  label: string;
  value: React.ReactNode;
  /** Render the value in JetBrains Mono (IDs, ports, paths). */
  mono?: boolean;
}

export function KeyValueList({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cn("text-sm", className)}>
      {items.map((it) => (
        <div
          key={it.label}
          className="grid gap-x-4 border-b sm:grid-cols-[minmax(7rem,10rem)_1fr] py-2 first:pt-0 last:border-0 last:pb-0"
        >
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className={cn("min-w-0 break-words", it.mono && "font-mono text-[0.92em]")}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
