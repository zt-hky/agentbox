"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
  runtimeH: { label: "Runtime (h)", color: "var(--chart-1)" },
  cpuCoreH: { label: "CPU (core-h)", color: "var(--chart-2)" },
} satisfies ChartConfig;

const DAY_MS = 86_400_000;
const round = (n: number) => Math.round(n * 100) / 100;

/** Sums hourly points into the 7 UTC days ending on `endDate`'s day, so empty days still show. */
export function toDaily(data: UsagePoint[], endDate: string) {
  const end = Date.UTC(
    new Date(endDate).getUTCFullYear(),
    new Date(endDate).getUTCMonth(),
    new Date(endDate).getUTCDate(),
  );
  const days = Array.from({ length: 7 }, (_, i) => {
    const t = end - (6 - i) * DAY_MS;
    return { key: new Date(t).toISOString().slice(0, 10), runtimeH: 0, cpuCoreH: 0 };
  });
  for (const p of data) {
    const d = days.find((x) => x.key === p.hour.slice(0, 10));
    if (d) {
      d.runtimeH += p.runtimeMin / 60;
      d.cpuCoreH += p.cpuCoreMin / 60;
    }
  }
  return days.map((d) => ({ ...d, runtimeH: round(d.runtimeH), cpuCoreH: round(d.cpuCoreH) }));
}

export function UsageChart({ data, endDate }: { data: UsagePoint[]; endDate: string }) {
  const daily = toDaily(data, endDate);
  return (
    <div>
      <div className="mb-3 flex gap-4 text-meta text-muted-foreground">
        {Object.entries(config).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ background: v.color }} />
            {v.label}
          </span>
        ))}
      </div>
      <ChartContainer config={config} className="aspect-auto h-52 w-full">
        <BarChart data={daily} barGap={3} margin={{ left: 0, right: 0, top: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis tickLine={false} axisLine={false} width={32} allowDecimals />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="runtimeH"
            fill="var(--color-runtimeH)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
            maxBarSize={20}
          />
          <Bar
            dataKey="cpuCoreH"
            fill="var(--color-cpuCoreH)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
            maxBarSize={20}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
