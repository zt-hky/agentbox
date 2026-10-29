import type { Metadata } from "next";
import { db } from "@agentbox/db/client";
import { PageHeader } from "@/components/page-header";
import { loadRack } from "@/lib/admin/workspaces-ops";
import { requireAdmin } from "@/lib/session";
import { RackList } from "./rack-list";

export const metadata: Metadata = { title: "Workspaces" };
export const dynamic = "force-dynamic";

export default async function AdminWorkspacesPage() {
  await requireAdmin();
  const now = new Date();
  const rows = await loadRack(db, now);
  const running = rows.filter((r) => r.status === "running").length;
  return (
    <>
      <PageHeader
        title="Workspaces"
        description={`${running} of ${rows.length} running. Readings come from the latest metering tick, about once a minute.`}
      />
      <RackList rows={rows} now={now.toISOString()} />
    </>
  );
}
