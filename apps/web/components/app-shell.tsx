import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isAdminUser, type AppSession } from "@/lib/session";
import { loadWorkspace } from "@/lib/user-data";

/** Flat sidebar shell: sidebar + slim header + content column (max ~1200px). */
export async function AppShell({
  session,
  children,
}: {
  session: AppSession;
  children: React.ReactNode;
}) {
  const u = session.user;
  const ws = await loadWorkspace(u.id);
  return (
    <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
      <AppSidebar
        user={{ name: u.name, email: u.email, image: u.image ?? null }}
        isAdmin={isAdminUser(u)}
        workspace={ws && ws.status !== "deleted" ? { slug: ws.slug, status: ws.status } : null}
      />
      <SidebarInset>
        <SiteHeader />
        <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-8 p-4 md:p-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
