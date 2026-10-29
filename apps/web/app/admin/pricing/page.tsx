import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { prices } from "@agentbox/db/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>New price version</CardTitle>
          <CardDescription>
            Usage beyond a plan&apos;s allowance is billed per hour in {label}s. A new version
            applies to metering from the next sample.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PriceForm
            label={label}
            initial={{
              runtimePerHour: current ? microToCredits(current.runtimePerHour) : "0.50",
              cpuCorePerHour: current ? microToCredits(current.cpuCorePerHour) : "0.20",
              memGbPerHour: current ? microToCredits(current.memGbPerHour) : "0.05",
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Runtime / h</TableHead>
                  <TableHead>CPU core / h</TableHead>
                  <TableHead>Memory GB / h</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      {formatDateTime(p.effectiveFrom)}
                      {current?.id === p.id ? " (current)" : ""}
                    </TableCell>
                    <TableCell>{microToCredits(p.runtimePerHour)}</TableCell>
                    <TableCell>{microToCredits(p.cpuCorePerHour)}</TableCell>
                    <TableCell>{microToCredits(p.memGbPerHour)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
