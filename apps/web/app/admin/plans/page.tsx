import type { Metadata } from "next";
import { readSetting, db } from "@agentbox/db/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { allPlans, creditLabel } from "@/lib/queries";
import { microToCredits } from "@/lib/money";
import { PlansPanel, type PlanRow } from "./plans-panel";

export const metadata: Metadata = { title: "Plans" };

export default async function AdminPlansPage() {
  const [rows, billing, label] = await Promise.all([
    allPlans(),
    readSetting(db, "billing"),
    creditLabel(),
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
    allowanceRuntimeHours: p.allowanceRuntimeHours,
    allowanceCpuCoreHours: p.allowanceCpuCoreHours,
    allowanceMemGbHours: p.allowanceMemGbHours,
    active: p.active,
    isDefault: billing?.defaultPlanId === p.id,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans</CardTitle>
        <CardDescription>
          Limits apply to each subscriber&apos;s workspace. Prices are in {label}s per month.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PlansPanel rows={data} />
      </CardContent>
    </Card>
  );
}
