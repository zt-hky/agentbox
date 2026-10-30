import { cn } from "@/lib/utils";

export type Tone = "ok" | "busy" | "error" | "idle";

/** Maps every workspace, job, image and access status to a light colour and a plain label. */
const STATUS: Record<string, { tone: Tone; label: string }> = {
  // workspace
  running: { tone: "ok", label: "Running" },
  starting: { tone: "busy", label: "Starting" },
  stopping: { tone: "busy", label: "Stopping" },
  provisioning: { tone: "busy", label: "Provisioning" },
  sleeping: { tone: "idle", label: "Asleep" },
  error: { tone: "error", label: "Error" },
  deleting: { tone: "busy", label: "Deleting" },
  deleted: { tone: "idle", label: "Deleted" },
  // job
  queued: { tone: "idle", label: "Queued" },
  done: { tone: "ok", label: "Done" },
  failed: { tone: "error", label: "Failed" },
  // image
  building: { tone: "busy", label: "Building" },
  ready: { tone: "ok", label: "Ready" },
  active: { tone: "ok", label: "Active" },
  retired: { tone: "idle", label: "Retired" },
  // access
  pending: { tone: "busy", label: "Pending" },
  approved: { tone: "ok", label: "Approved" },
  none: { tone: "idle", label: "No access" },
  rejected: { tone: "error", label: "Rejected" },
  suspended: { tone: "error", label: "Suspended" },
  // toolchain tools and runs
  installing: { tone: "busy", label: "Installing" },
  removing: { tone: "busy", label: "Removing" },
  waiting: { tone: "busy", label: "Waiting for start" },
  external: { tone: "idle", label: "From image" },
  succeeded: { tone: "ok", label: "Succeeded" },
  partial: { tone: "error", label: "Partly failed" },
  interrupted: { tone: "error", label: "Interrupted" },
  cancelled: { tone: "idle", label: "Cancelled" },
};

export function statusTone(status: string): Tone {
  return STATUS[status]?.tone ?? "idle";
}

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-status-ok",
  busy: "bg-status-busy",
  error: "bg-status-error",
  idle: "bg-status-idle",
};
const TONE_VAR: Record<Tone, string> = {
  ok: "var(--status-ok)",
  busy: "var(--status-busy)",
  error: "var(--status-error)",
  idle: "var(--status-idle)",
};
const SIZE: Record<"sm" | "md" | "lg", string> = { sm: "size-2", md: "size-2.5", lg: "size-4" };

/**
 * A single lamp. Colour is state only. When the status changes the element remounts (keyed by
 * status) and pulses once; reduced-motion users get no animation.
 */
export function StatusLight({
  status,
  size = "md",
  label,
  className,
}: {
  status: string;
  size?: "sm" | "md" | "lg";
  /** Accessible name; defaults to the status label. Pass `null` to hide from assistive tech. */
  label?: string | null;
  className?: string;
}) {
  const tone = statusTone(status);
  const name = label === undefined ? statusLabel(status) : label;
  return (
    <span
      key={status}
      role={name ? "img" : undefined}
      aria-label={name ?? undefined}
      aria-hidden={name ? undefined : true}
      style={{ "--light": TONE_VAR[tone] } as React.CSSProperties}
      className={cn(
        "status-pulse inline-block shrink-0 rounded-full",
        SIZE[size],
        size === "lg" && tone === "ok" && "shadow-[0_0_12px_var(--light)]",
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}

/** What the state means for the workspace's owner, in plain language. */
export function describeWorkspaceStatus(status: string): string {
  switch (status) {
    case "running":
      return "Running. Your workspace is awake and ready.";
    case "sleeping":
      return "Asleep. Opening it wakes it in about 10 seconds.";
    case "starting":
      return "Waking up. This takes about 10 seconds.";
    case "stopping":
      return "Going to sleep.";
    case "provisioning":
      return "Being set up. This usually takes a minute or two.";
    case "error":
      return "It could not start. Try opening it again; if that fails, contact an administrator.";
    case "deleting":
      return "Being deleted.";
    case "deleted":
      return "This workspace was deleted.";
    default:
      return statusLabel(status);
  }
}
