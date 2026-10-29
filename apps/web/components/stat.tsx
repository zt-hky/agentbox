import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xl font-semibold tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-meta text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
