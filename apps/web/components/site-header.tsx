"use client";

import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { crumbsForPath } from "@/components/nav-config";

/** Slim top bar: sidebar toggle and where you are. The page's own h1 lives in PageHeader. */
export function SiteHeader() {
  const crumbs = crumbsForPath(usePathname());
  return (
    <header className="glass sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-4 lg:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {crumbs.map((c, i) => (
            <li key={c} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              <span className={i === crumbs.length - 1 ? "text-foreground" : undefined}>{c}</span>
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}
