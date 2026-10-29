import { Meter } from "@/components/meter";

interface Allowance {
  usedRuntimeHours: number;
  usedCpuCoreHours: number;
  usedMemGbHours: number;
}
interface PlanAllowance {
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
}

const fmt = (unit: string) => (v: number, m: number) =>
  `${v.toFixed(1)} of ${m.toFixed(0)} ${unit}`;

/** What the plan includes each cycle and how much of it is used. */
export function AllowanceMeters({ used, plan }: { used: Allowance; plan: PlanAllowance }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      <Meter
        label="Runtime"
        value={used.usedRuntimeHours}
        max={plan.allowanceRuntimeHours}
        format={fmt("h")}
      />
      <Meter
        label="CPU"
        value={used.usedCpuCoreHours}
        max={plan.allowanceCpuCoreHours}
        format={fmt("core-h")}
      />
      <Meter
        label="Memory"
        value={used.usedMemGbHours}
        max={plan.allowanceMemGbHours}
        format={fmt("GB-h")}
      />
    </div>
  );
}
