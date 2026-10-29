import { Badge } from "@/components/ui/badge";

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  starting: "secondary",
  stopping: "secondary",
  provisioning: "secondary",
  sleeping: "outline",
  error: "destructive",
  deleting: "destructive",
  deleted: "outline",
  active: "default",
  pending: "secondary",
  none: "outline",
  rejected: "destructive",
  suspended: "destructive",
  approved: "default",
  building: "secondary",
  ready: "outline",
  failed: "destructive",
  retired: "outline",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? "outline"}>{status}</Badge>;
}
