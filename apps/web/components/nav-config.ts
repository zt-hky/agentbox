import {
  Box,
  CreditCard,
  GitBranch,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Server,
  Settings,
  Tag,
  UserPlus,
  Users,
  Wallet,
  KeyRound,
} from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  /** Match only the exact path (for index routes). */
  exact?: boolean;
}

export const USER_NAV: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard, exact: true },
  { title: "Billing", url: "/billing", icon: CreditCard },
  { title: "GitHub", url: "/settings/github", icon: GitBranch },
  { title: "Sessions", url: "/settings/sessions", icon: KeyRound },
];

export interface NavGroupConfig {
  label: string;
  items: NavItem[];
}

export const ADMIN_NAV_GROUPS: NavGroupConfig[] = [
  {
    label: "People",
    items: [
      { title: "Requests", url: "/admin/requests", icon: UserPlus },
      { title: "Users", url: "/admin/users", icon: Users },
    ],
  },
  {
    label: "Workspaces",
    items: [{ title: "Workspaces", url: "/admin/workspaces", icon: Box }],
  },
  {
    label: "Platform",
    items: [
      { title: "Overview", url: "/admin", icon: Server, exact: true },
      { title: "Jobs", url: "/admin/jobs", icon: ListChecks },
      { title: "Images", url: "/admin/images", icon: ImageIcon },
      { title: "Settings", url: "/admin/settings", icon: Settings },
      { title: "Audit log", url: "/admin/audit", icon: History },
    ],
  },
  {
    label: "Billing",
    items: [
      { title: "Plans", url: "/admin/plans", icon: Wallet },
      { title: "Pricing", url: "/admin/pricing", icon: Tag },
    ],
  },
];

export function isActivePath(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.url;
  return pathname === item.url || pathname.startsWith(`${item.url}/`);
}

/** Breadcrumb trail for the header: admin pages read "Admin / Group / Page". */
export function crumbsForPath(pathname: string): string[] {
  const groups: NavGroupConfig[] = [{ label: "Workspace", items: USER_NAV }, ...ADMIN_NAV_GROUPS];
  let best: { group: string; item: NavItem } | null = null;
  for (const g of groups) {
    for (const item of g.items) {
      if (isActivePath(item, pathname) && (!best || item.url.length > best.item.url.length)) {
        best = { group: g.label, item };
      }
    }
  }
  if (!best) return ["AgentBox"];
  if (!pathname.startsWith("/admin")) return [best.item.title];
  return best.group === best.item.title
    ? ["Admin", best.item.title]
    : ["Admin", best.group, best.item.title];
}
