import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/** Scrollable mono block for logs and process lists, with a copy button. */
export function CodeBlock({
  text,
  wrap = false,
  maxHeight = "28rem",
  label,
  className,
}: {
  text: string;
  wrap?: boolean;
  maxHeight?: string;
  /** Accessible name for the scroll region. */
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative rounded-lg border bg-rack", className)}>
      <div className="absolute top-2 right-2 z-10">
        <CopyButton text={text} />
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={label ?? "Output"}
        style={{ maxHeight }}
        className={cn(
          "overflow-auto p-4 pr-24 font-mono text-[13px] leading-5",
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        )}
      >
        {text || " "}
      </pre>
    </div>
  );
}
