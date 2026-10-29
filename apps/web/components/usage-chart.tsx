"use client";

import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface UsagePoint {
  /** ISO hour start. */
  hour: string;
  runtimeMin: number;
  cpuCoreMin: number;
}

const config = {
  runtimeMin: { label: "Runtime (min)", color: "var(--chart-1)" },
  cpuCoreMin: { label: "CPU (core-min)", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function UsageChart({ data }: { data: UsagePoint[] }) {
  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No usage in the last 7 days.</p>
    );
  }
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <AreaChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="hour"
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(v: string) => v.slice(5, 13).replace("T", " ") + "h"}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="runtimeMin"
          type="monotone"
          fill="var(--color-runtimeMin)"
          fillOpacity={0.3}
          stroke="var(--color-runtimeMin)"
        />
        <Area
          dataKey="cpuCoreMin"
          type="monotone"
          fill="var(--color-cpuCoreMin)"
          fillOpacity={0.3}
          stroke="var(--color-cpuCoreMin)"
        />
      </AreaChart>
    </ChartContainer>
  );
}
