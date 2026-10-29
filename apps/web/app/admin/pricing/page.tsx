import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { prices } from "@agentbox/db/schema";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { microToCredits } from "@/lib/money";
import { creditLabel, currentPrices } from "@/lib/queries";
import { PriceForm } from "./price-form";

export const metadata: Metadata = { title: "Pricing" };

export default async function AdminPricingPage() {
  const [history, current, label] = await Promise.all([
    db.select().from(prices).orderBy(desc(prices.effectiveFrom)).limit(50),
    currentPrices(),
    creditLabel(),
  ]);
  return (
    <>
      <PageHeader
        title="Pricing"
        description={`Usage beyond a plan's allowance is billed per hour in ${label}s. A new version applies to metering from the next sample.`}
      />
      <Section
        title="Publish a new price version"
        description="Past versions stay in the history below."
      >
        <PriceForm
          label={label}
          initial={{
            runtimePerHour: current ? microToCredits(current.runtimePerHour) : "0.50",
            cpuCorePerHour: current ? microToCredits(current.cpuCorePerHour) : "0.20",
            memGbPerHour: current ? microToCredits(current.memGbPerHour) : "0.05",
          }}
        />
      </Section>
      <Section title="History" bodyClassName="p-0">
        <Table>
          <TableHeader className="bg-rack">
            <TableRow>
              {[
                "Effective from",
                "Runtime per hour",
                "CPU core per hour",
                "Memory GB per hour",
                "State",
              ].map((t, i) => (
                <TableHead
                  key={t}
                  className={`h-9 text-meta font-medium text-muted-foreground ${i === 0 ? "pl-5" : ""} ${i === 4 ? "pr-5" : ""}`}
                >
                  {t}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-5 whitespace-nowrap">
                  {formatDateTime(p.effectiveFrom)}
                </TableCell>
                <TableCell>{microToCredits(p.runtimePerHour)}</TableCell>
                <TableCell>{microToCredits(p.cpuCorePerHour)}</TableCell>
                <TableCell>{microToCredits(p.memGbPerHour)}</TableCell>
                <TableCell className="pr-5">
                  {current?.id === p.id ? <StatusBadge status="active" label="Current" /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
