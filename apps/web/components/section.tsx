import { cn } from "@/lib/utils";

/** Titled panel. Use for a block that needs a heading; plain content does not need one. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-card text-card-foreground", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-base">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
