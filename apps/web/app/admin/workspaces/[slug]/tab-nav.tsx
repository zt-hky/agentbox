import Link from "next/link";
import { cn } from "@/lib/utils";

export const WORKSPACE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
  { id: "processes", label: "Processes" },
  { id: "logs", label: "Logs" },
  { id: "events", label: "Events" },
  { id: "jobs", label: "Jobs" },
  { id: "manage", label: "Manage" },
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]["id"];

export function parseTab(v: string | undefined): WorkspaceTab {
  return WORKSPACE_TABS.find((t) => t.id === v)?.id ?? "overview";
}

/** Tabs are links (`?tab=`), so each tab loads only its own data and can be shared or reloaded. */
export function TabNav({ slug, current }: { slug: string; current: WorkspaceTab }) {
  return (
    <nav aria-label="Workspace sections" className="-mx-1 overflow-x-auto border-b px-1">
      <ul className="flex min-w-max gap-1">
        {WORKSPACE_TABS.map((t) => (
          <li key={t.id}>
            <Link
              href={
                t.id === "overview"
                  ? `/admin/workspaces/${slug}`
                  : `/admin/workspaces/${slug}?tab=${t.id}`
              }
              aria-current={t.id === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center rounded-t-md border-b-2 px-3 text-sm font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                t.id === current
                  ? "border-signal text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
