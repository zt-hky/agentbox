import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

const TOOLS = [
  ["T3 Code", "agent workspace in the browser"],
  ["VS Code", "full editor with extensions"],
  ["Claude Code", "terminal agent"],
  ["Codex", "terminal agent"],
  ["Oh My Pi", "terminal agent"],
] as const;

/** Shared frame for login and the waiting page: form column plus an ink panel on wide screens. */
export function AuthShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
      <main className="flex flex-col justify-center px-6 py-10 sm:px-12 lg:px-20">
        <div className={cn("flex w-full max-w-md flex-col gap-8", className)}>
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
            <Logo className="size-7" />
            AgentBox
          </div>
          {children}
        </div>
      </main>
      <aside
        aria-label="What you get"
        className="hidden flex-col justify-end gap-6 bg-[#1a1e1c] p-12 text-[#e9ecea] lg:flex"
      >
        <h2 className="max-w-xs text-xl leading-snug font-semibold text-[#e9ecea]">
          Your own machine for coding agents, asleep until you need it.
        </h2>
        <ul className="grid gap-3 text-sm">
          {TOOLS.map(([name, what]) => (
            <li
              key={name}
              className="grid grid-cols-[7rem_1fr] gap-3 border-t border-white/10 pt-3"
            >
              <span className="font-mono text-[13px] text-[#3fc3aa]">{name}</span>
              <span className="text-[#97a09b]">{what}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
