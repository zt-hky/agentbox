import { Badge } from "@/components/ui/badge";
import { StatusLight, statusLabel } from "@/components/status-light";

/** Pill with a lamp and a word, so state never relies on colour alone. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge variant="status">
      <StatusLight status={status} size="sm" label={null} />
      {label ?? statusLabel(status)}
    </Badge>
  );
}
