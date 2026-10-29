import Image from "next/image";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

const TOOLS = [
  ["T3 Code", "agent workspace in the browser"],
  ["VS Code", "full editor with extensions"],
  ["Claude Code", "terminal agent"],
  ["Codex", "terminal agent"],
  ["Oh My Pi", "terminal agent"],
] as const;

/** The AgentBox object, static: the glowing "awake" box. */
function BoxObject({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/box-awake.svg"
      alt=""
      width={800}
      height={800}
      unoptimized
      priority
      className={className}
    />
  );
}

/**
 * Shared frame for login and the waiting page: always Night (brand backdrop), form column plus
 * the static AgentBox object and the tool list on wide screens.
 */
export function AuthShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="dark night-backdrop min-h-svh text-foreground">
      <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
        <main className="flex flex-col items-center justify-center px-6 py-10 sm:px-12">
          <div className={cn("flex w-full max-w-md flex-col gap-8", className)}>
            <div className="flex items-center gap-2.5 text-lg font-semibold">
              <Logo className="size-8" />
              AgentBox
            </div>
            <BoxObject className="-my-2 size-28 lg:hidden" />
            {children}
          </div>
        </main>
        <aside
          aria-label="What you get"
          className="hidden flex-col justify-center gap-8 border-l border-white/8 bg-white/[0.02] p-12 lg:flex"
        >
          <BoxObject className="size-56 self-center" />
          <h2 className="max-w-sm text-2xl leading-tight font-semibold">
            Every agent deserves a machine of its own.
          </h2>
          <ul className="grid gap-3 text-sm">
            {TOOLS.map(([name, what]) => (
              <li
                key={name}
                className="grid grid-cols-[7rem_1fr] gap-3 border-t border-white/10 pt-3"
              >
                <span className="font-mono text-[13px] text-status-ok">{name}</span>
                <span className="text-muted-foreground">{what}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
