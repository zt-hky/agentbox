import { AppShell } from "@/components/app-shell";
import { requireOnboardedUser } from "@/lib/session";

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const session = await requireOnboardedUser();
  return <AppShell session={session}>{children}</AppShell>;
}
