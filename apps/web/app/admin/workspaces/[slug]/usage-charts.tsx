"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { UsageChartPoint, UsageRange } from "@/lib/admin/workspaces";

const axisTime = (range: UsageRange) => (iso: string) =>
  range === "24h" ? iso.slice(11, 16) : iso.slice(5, 10);
const fullTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 className="text-sm">{title}</h3>
        <span className="text-meta text-muted-foreground">{hint}</span>
      </div>
      {children}
    </div>
  );
}

/** CPU cores, memory and charge over time from `usage_samples`; idle stretches are gaps. */
export function UsageCharts({
  data,
  range,
  cpuLimit,
  memLimitGb,
}: {
  data: UsageChartPoint[];
  range: UsageRange;
  cpuLimit: number | null;
  memLimitGb: number | null;
}) {
  const cpuConfig = {
    cpuCores: { label: "CPU cores", color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const memConfig = {
    memGb: { label: "Memory (GB)", color: "var(--chart-2)" },
  } satisfies ChartConfig;
  const chargeConfig = {
    charge: { label: "Charge", color: "var(--chart-3)" },
  } satisfies ChartConfig;
  const tick = axisTime(range);
  const common = { data, margin: { left: 0, right: 8, top: 4 } };
  const xAxis = (
    <XAxis
      dataKey="t"
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={48}
      tickFormatter={tick}
    />
  );
  const tooltip = (
    <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => fullTime(String(v))} />} />
  );
  return (
    <div className="grid gap-8">
      <Panel
        title="CPU"
        hint={
          cpuLimit
            ? `Average cores busy while running, plan limit ${cpuLimit}`
            : "Average cores busy while running"
        }
      >
        <ChartContainer config={cpuConfig} className="aspect-auto h-44 w-full">
          <AreaChart {...common}>
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={36}
              domain={[0, cpuLimit ?? "auto"]}
              allowDecimals
            />
            {tooltip}
            <Area
              dataKey="cpuCores"
              type="monotone"
              stroke="var(--color-cpuCores)"
              fill="var(--color-cpuCores)"
              fillOpacity={0.18}
              strokeWidth={1.5}
              isAnimationActive={false}
              connectNulls={false}
            />
          </AreaChart>
        </ChartContainer>
      </Panel>
      <Panel
        title="Memory"
        hint={
          memLimitGb
            ? `Average GB while running, plan limit ${memLimitGb}`
            : "Average GB while running"
        }
      >
        <ChartContainer config={memConfig} className="aspect-auto h-44 w-full">
          <AreaChart {...common}>
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={36}
              domain={[0, memLimitGb ?? "auto"]}
              allowDecimals
            />
            {tooltip}
            <Area
              dataKey="memGb"
              type="monotone"
              stroke="var(--color-memGb)"
              fill="var(--color-memGb)"
              fillOpacity={0.18}
              strokeWidth={1.5}
              isAnimationActive={false}
              connectNulls={false}
            />
          </AreaChart>
        </ChartContainer>
      </Panel>
      <Panel title="Charge" hint="Credits charged per interval">
        <ChartContainer config={chargeConfig} className="aspect-auto h-36 w-full">
          <BarChart {...common}>
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={52}
              allowDecimals
              tickFormatter={(v: number) => String(+v.toFixed(4))}
            />
            {tooltip}
            <Bar
              dataKey="charge"
              fill="var(--color-charge)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
              maxBarSize={10}
            />
          </BarChart>
        </ChartContainer>
      </Panel>
    </div>
  );
}
