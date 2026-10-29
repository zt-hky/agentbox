import { Progress } from "@/components/ui/progress";

export function AllowanceBar({
  label,
  used,
  total,
  unit,
}: {
  label: string;
  used: number;
  total: number;
  unit: string;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 100;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {used.toFixed(2)} / {total.toFixed(0)} {unit}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}
