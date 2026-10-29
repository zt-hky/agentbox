import type { Metadata } from "next";
import { readSetting, db } from "@agentbox/db/client";
import { allPlans, billingDisplay } from "@/lib/queries";
import { microToCredits } from "@/lib/money";
import { PlansPanel, type PlanRow } from "./plans-panel";

export const metadata: Metadata = { title: "Plans" };

export default async function AdminPlansPage() {
  const [rows, billing, display] = await Promise.all([
    allPlans(),
    readSetting(db, "billing"),
    billingDisplay(),
  ]);
  const data: PlanRow[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    monthlyPrice: microToCredits(p.monthlyPriceMicro),
    cpuLimit: Number(p.cpuLimit),
    memoryLimitMb: p.memoryLimitMb,
    diskLimitGb: p.diskLimitGb,
    pidsLimit: p.pidsLimit,
    inodesLimit: p.inodesLimit,
    allowanceRuntimeHours: p.allowanceRuntimeHours,
    allowanceCpuCoreHours: p.allowanceCpuCoreHours,
    allowanceMemGbHours: p.allowanceMemGbHours,
    trialDays: p.trialDays,
    dailyRuntimeHours: p.dailyRuntimeHours,
    maxAwakeHours: p.maxAwakeHours,
    idleTimeoutMinutes: p.idleTimeoutMinutes,
    sortOrder: p.sortOrder,
    public: p.public,
    active: p.active,
    isDefault: billing?.defaultPlanId === p.id,
  }));
  return <PlansPanel rows={data} label={display.label} creditValueVnd={display.creditValueVnd} />;
}
