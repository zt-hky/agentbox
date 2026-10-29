import { AppShell } from "@/components/app-shell";
import { requireActiveUser } from "@/lib/session";

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const session = await requireActiveUser();
  return <AppShell session={session}>{children}</AppShell>;
}
