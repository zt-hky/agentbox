"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { Mono } from "@/components/mono";
import { StatusLight, statusLabel } from "@/components/status-light";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ADMIN_NAV_GROUPS, USER_NAV, isActivePath, type NavItem } from "@/components/nav-config";

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={isActivePath(item, pathname)}
                className="data-[active=true]:text-signal data-[active=true]:[&>svg]:text-signal"
              >
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({
  user,
  isAdmin,
  workspace,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; image: string | null };
  isAdmin: boolean;
  workspace: { slug: string; status: string } | null;
}) {
  return (
    <Sidebar collapsible="offcanvas" variant="sidebar" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
              <Link href="/">
                <Logo className="size-6!" />
                <span className="text-base font-semibold tracking-tight">AgentBox</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Workspace" items={USER_NAV} />
        {isAdmin
          ? ADMIN_NAV_GROUPS.map((g) => <NavGroup key={g.label} label={g.label} items={g.items} />)
          : null}
      </SidebarContent>
      <SidebarFooter>
        {workspace ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip={`${workspace.slug}: ${statusLabel(workspace.status)}`}
              >
                <Link href="/">
                  <StatusLight status={workspace.status} label={null} />
                  <Mono className="truncate">{workspace.slug}</Mono>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {statusLabel(workspace.status)}
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
