import { cn } from "@/lib/utils";

export interface MeterProps {
  label: string;
  /** Current level; `null` shows an empty meter with "no data". */
  value: number | null;
  max: number;
  /** Text for the right-hand readout. Default: `value / max`. */
  format?: (value: number, max: number) => string;
  /** Readout when `value` is null. Default "no data". */
  emptyText?: string;
  /** Compact: single line, no label row (for table cells and rows). */
  compact?: boolean;
  /** Force a tone; by default the fill turns amber at 75% and red at 90%. */
  tone?: "auto" | "signal";
  className?: string;
}

const defaultFormat = (v: number, m: number) => `${+v.toFixed(2)} / ${+m.toFixed(2)}`;

/** Horizontal level meter: 20 segments, role="meter". Server-friendly. */
export function Meter({
  label,
  value,
  max,
  format = defaultFormat,
  compact = false,
  emptyText = "no data",
  tone = "auto",
  className,
}: MeterProps) {
  const known = value !== null && max > 0;
  const ratio = known ? Math.min(1, Math.max(0, value / max)) : 0;
  const fill =
    tone === "auto" && ratio >= 0.9
      ? "bg-status-error"
      : tone === "auto" && ratio >= 0.75
        ? "bg-status-busy"
        : "bg-signal";
  const text = known ? format(value, max) : emptyText;
  const bar = (
    <div className="meter-cells relative h-2 w-full bg-border" aria-hidden="true">
      <div className={cn("absolute inset-y-0 left-0", fill)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
  const aria = {
    role: "meter" as const,
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": max,
    "aria-valuenow": known ? value : undefined,
    "aria-valuetext": text,
  };
  if (compact) {
    return (
      <div {...aria} className={cn("grid min-w-24 gap-1", className)} title={`${label}: ${text}`}>
        {bar}
        <span className="text-xs leading-none text-muted-foreground">{text}</span>
      </div>
    );
  }
  return (
    <div {...aria} className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span
          className={cn("text-meta", known ? "text-muted-foreground" : "text-muted-foreground/70")}
        >
          {text}
        </span>
      </div>
      {bar}
    </div>
  );
}
