import { cn } from "@/lib/utils";

/** Inline message: what happened and how to fix it. */
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "error";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "bg-rack text-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
