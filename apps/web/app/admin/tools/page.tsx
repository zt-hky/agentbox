import type { Metadata } from "next";
import { db } from "@agentbox/db/client";
import { PageHeader } from "@/components/page-header";
import { loadAdminToolchain } from "@/lib/admin/toolchain-ops";
import { CatalogForm } from "./catalog-form";
import { FleetSection } from "./fleet-section";
import { LatestSection } from "./latest-section";

export const metadata: Metadata = { title: "Tools" };
export const dynamic = "force-dynamic";

export default async function AdminToolsPage() {
  const view = await loadAdminToolchain(db);
  return (
    <>
      <PageHeader
        title="Tools"
        description="Which runtimes and agent CLIs workspaces can install, what they get by default, and where every workspace stands."
      />
      <CatalogForm catalog={view.catalog} />
      <LatestSection rows={view.latest} />
      <FleetSection
        fleet={view.fleet}
        tools={view.catalog
          .filter((c) => !c.disabled)
          .map((c) => ({ toolId: c.toolId, label: c.label }))}
        liveCount={view.liveCount}
        runningCount={view.runningCount}
      />
    </>
  );
}
