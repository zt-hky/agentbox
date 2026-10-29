import { cn } from "@/lib/utils";

/** Three level bars: the meter motif of the workspace module. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6", className)}>
      <rect width="32" height="32" rx="8" fill="var(--foreground)" />
      <rect x="7" y="9" width="18" height="3" rx="1.5" fill="var(--signal)" />
      <rect x="7" y="14.5" width="12" height="3" rx="1.5" fill="var(--background)" />
      <rect x="7" y="20" width="15" height="3" rx="1.5" fill="var(--background)" />
    </svg>
  );
}
