import { cn } from "@/lib/utils";

/** Inline machine text: slugs as hostnames, image IDs, ports, UIDs, commands. */
export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[0.92em] tracking-normal", className)}>{children}</span>
  );
}
