import { StatusLight, type Tone } from "@/components/status-light";
import { cn } from "@/lib/utils";

export interface TimelineItem {
  id?: string;
  title: React.ReactNode;
  /** Already formatted, e.g. `formatDateTime(d)`. */
  time: React.ReactNode;
  detail?: React.ReactNode;
  /** Lamp colour for this event; omit for a neutral dot. */
  status?: string;
}

export type { Tone };

export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn("relative", className)}>
      {items.map((it, i) => (
        <li key={it.id ?? i} className="relative grid grid-cols-[1rem_1fr] gap-x-3 pb-5 last:pb-0">
          {i < items.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-3 bottom-0 left-[7.5px] w-px bg-border"
            />
          ) : null}
          <span className="relative mt-1.5 flex size-4 items-start justify-center">
            {it.status ? (
              <StatusLight status={it.status} size="sm" label={null} className="mt-px" />
            ) : (
              <span className="mt-px size-2 rounded-full border bg-card" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
              <span className="font-medium">{it.title}</span>
              <span className="text-meta text-muted-foreground">{it.time}</span>
            </div>
            {it.detail ? (
              <div className="mt-0.5 text-meta break-words text-muted-foreground">{it.detail}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
