import type { Metadata } from "next";
import { db, readSetting } from "@agentbox/db/client";
import { PageHeader } from "@/components/page-header";
import { allPlans } from "@/lib/queries";
import { SettingsForms } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

export default async function AdminSettingsPage() {
  const [hibernation, capacity, billing, plans] = await Promise.all([
    readSetting(db, "hibernation"),
    readSetting(db, "capacity"),
    readSetting(db, "billing"),
    allPlans(),
  ]);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Platform rules for sleeping workspaces, memory capacity and billing. Each group saves on its own and is recorded in the audit log."
      />
      <SettingsForms
        hibernation={
          hibernation ?? {
            idleTimeoutMinutes: 30,
            idleCpuPercent: 5,
            idleNetBytesPerMin: 32768,
            maxAwakeHours: 24,
          }
        }
        capacity={capacity ?? { maxRunningMemoryRatio: 0.8 }}
        billing={billing}
        plans={plans.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
