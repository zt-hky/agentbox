import {
  Box,
  CreditCard,
  GitBranch,
  History,
  Image as ImageIcon,
  LayoutDashboard,
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

export const ADMIN_NAV: NavItem[] = [
  { title: "Overview", url: "/admin", icon: Server, exact: true },
  { title: "Requests", url: "/admin/requests", icon: UserPlus },
  { title: "Users", url: "/admin/users", icon: Users },
  { title: "Workspaces", url: "/admin/workspaces", icon: Box },
  { title: "Images", url: "/admin/images", icon: ImageIcon },
  { title: "Plans", url: "/admin/plans", icon: Wallet },
  { title: "Pricing", url: "/admin/pricing", icon: Tag },
  { title: "Settings", url: "/admin/settings", icon: Settings },
  { title: "Audit log", url: "/admin/audit", icon: History },
];

export function isActivePath(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.url;
  return pathname === item.url || pathname.startsWith(`${item.url}/`);
}

export function titleForPath(pathname: string): string {
  const all = [...USER_NAV, ...ADMIN_NAV];
  const match = all
    .filter((i) => isActivePath(i, pathname))
    .sort((a, b) => b.url.length - a.url.length)[0];
  return match?.title ?? "AgentBox";
}
