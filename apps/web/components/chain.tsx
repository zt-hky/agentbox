import { Check, X } from "lucide-react";
import { HashTicker, stableHash } from "@/components/hash-ticker";
import { cn } from "@/lib/utils";

export type ChainState = "pending" | "active" | "done" | "failed";

export interface ChainItem {
  key: string;
  label: string;
  detail?: string;
  state: ChainState;
}

/**
 * Blocks linked by lines, like a chain of blocks being appended. The active block pulses and its
 * hash ticks; the link into it flows. Everything stops once no item is `active`.
 * Motion exception: only for onboarding and tool install/remove/upgrade progress.
 */
export function Chain({
  items,
  className,
  orientation = "horizontal",
}: {
  items: ChainItem[];
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  const vertical = orientation === "vertical";
  return (
    <ol
      className={cn(
        "flex",
        vertical ? "flex-col" : "flex-col sm:flex-row sm:items-stretch",
        className,
      )}
    >
      {items.map((item, i) => {
        const prev = items[i - 1];
        const linkState: ChainState | null = prev ? item.state : null;
        return (
          <li
            key={item.key}
            className={cn("flex min-w-0 flex-1", vertical ? "flex-col" : "flex-col sm:flex-row")}
          >
            {linkState ? (
              <div
                aria-hidden
                data-state={linkState}
                className={cn(
                  "chain-link shrink-0",
                  vertical
                    ? "mx-auto h-5 w-0.5"
                    : "mx-auto h-5 w-0.5 sm:mx-0 sm:my-auto sm:h-0.5 sm:w-6",
                )}
              />
            ) : null}
            <div
              data-state={item.state}
              style={{ "--i": i } as React.CSSProperties}
              className="chain-block chain-reveal min-w-0 flex-1 rounded-lg border bg-card px-3.5 py-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                    item.state === "done" && "border-primary bg-primary text-primary-foreground",
                    item.state === "failed" &&
                      "border-status-error bg-status-error text-background",
                    item.state === "active" && "border-primary text-signal",
                    item.state === "pending" && "text-muted-foreground",
                  )}
                >
                  {item.state === "done" ? (
                    <Check className="size-3" aria-hidden />
                  ) : item.state === "failed" ? (
                    <X className="size-3" aria-hidden />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="truncate text-sm font-medium">{item.label}</span>
              </div>
              <div className="mt-1.5 truncate text-meta text-muted-foreground">
                {item.detail ?? <span className="sr-only">{item.state}</span>}
              </div>
              <div className="mt-1 text-muted-foreground">
                <HashTicker
                  active={item.state === "active"}
                  settled={item.state === "pending" ? "·".repeat(16) : stableHash(item.key)}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Thin progress bar; the sweep runs only while `active`. */
export function ChainBar({
  value,
  active,
  label,
}: {
  value: number;
  active: boolean;
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      data-active={active}
      className="chain-bar"
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
