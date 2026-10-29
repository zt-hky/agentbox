import { AppShell } from "@/components/app-shell";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  return <AppShell session={session}>{children}</AppShell>;
}
