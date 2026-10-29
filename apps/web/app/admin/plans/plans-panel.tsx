"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { planSchema } from "@/lib/schemas";
import { deletePlan, savePlan } from "./actions";

export interface PlanRow {
  id: string;
  name: string;
  kind: "free" | "package" | "payg";
  monthlyPrice: string;
  cpuLimit: number;
  memoryLimitMb: number;
  diskLimitGb: number;
  pidsLimit: number;
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
  active: boolean;
  isDefault: boolean;
}

type FormInput = z.input<typeof planSchema>;
type FormOutput = z.output<typeof planSchema>;

const NUMBER_FIELDS: { name: Path<FormInput>; label: string }[] = [
  { name: "cpuLimit", label: "CPU cores" },
  { name: "memoryLimitMb", label: "Memory (MB)" },
  { name: "diskLimitGb", label: "Disk (GB)" },
  { name: "pidsLimit", label: "PIDs limit" },
  { name: "allowanceRuntimeHours", label: "Allowance: runtime hours" },
  { name: "allowanceCpuCoreHours", label: "Allowance: CPU core-hours" },
  { name: "allowanceMemGbHours", label: "Allowance: memory GB-hours" },
];

function PlanDialog({ row, onClose }: { row: PlanRow | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(planSchema),
    defaultValues: row
      ? {
          name: row.name,
          kind: row.kind,
          monthlyPrice: row.monthlyPrice,
          cpuLimit: String(row.cpuLimit),
          memoryLimitMb: String(row.memoryLimitMb),
          diskLimitGb: String(row.diskLimitGb),
          pidsLimit: String(row.pidsLimit),
          allowanceRuntimeHours: String(row.allowanceRuntimeHours),
          allowanceCpuCoreHours: String(row.allowanceCpuCoreHours),
          allowanceMemGbHours: String(row.allowanceMemGbHours),
          active: row.active,
        }
      : {
          name: "",
          kind: "package",
          monthlyPrice: "0",
          cpuLimit: "2",
          memoryLimitMb: "4096",
          diskLimitGb: "10",
          pidsLimit: "2048",
          allowanceRuntimeHours: "0",
          allowanceCpuCoreHours: "0",
          allowanceMemGbHours: "0",
          active: true,
        },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{row ? `Edit ${row.name}` : "New plan"}</DialogTitle>
          <DialogDescription>
            Changing limits queues a limits update for running and sleeping workspaces on this plan.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={form.handleSubmit((values) =>
              start(async () => {
                const res = await savePlan(row?.id ?? null, values);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success("Plan saved");
                onClose();
                router.refresh();
              }),
            )}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="free">free</SelectItem>
                      <SelectItem value="package">package</SelectItem>
                      <SelectItem value="payg">payg</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="monthlyPrice"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monthly price (credits)</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {NUMBER_FIELDS.map((f) => (
              <FormField
                key={f.name}
                control={form.control}
                name={f.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{f.label}</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        onChange={field.onChange}
                        value={String(field.value ?? "")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 sm:col-span-2">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(c) => field.onChange(c === true)}
                    />
                  </FormControl>
                  <FormLabel>Active (can be assigned to users)</FormLabel>
                </FormItem>
              )}
            />
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" disabled={pending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function PlansPanel({ rows }: { rows: PlanRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [pending, start] = useTransition();

  const h = columnHelper<PlanRow>();
  const columns = [
    h.accessor("name", {
      header: "Plan",
      cell: (c) => (
        <div className="flex items-center gap-2 font-medium">
          {c.getValue()}
          {c.row.original.isDefault ? <Badge variant="secondary">default</Badge> : null}
          {c.row.original.active ? null : <Badge variant="outline">inactive</Badge>}
        </div>
      ),
    }),
    h.accessor("kind", { header: "Kind" }),
    h.accessor("monthlyPrice", { header: "Monthly" }),
    h.display({
      id: "limits",
      header: "Limits",
      cell: (c) => {
        const r = c.row.original;
        return `${r.cpuLimit} CPU / ${r.memoryLimitMb} MB / ${r.diskLimitGb} GB / ${r.pidsLimit} pids`;
      },
    }),
    h.display({
      id: "allowance",
      header: "Allowance",
      cell: (c) => {
        const r = c.row.original;
        return `${r.allowanceRuntimeHours} h / ${r.allowanceCpuCoreHours} core-h / ${r.allowanceMemGbHours} GB-h`;
      },
    }),
    h.display({
      id: "actions",
      header: "",
      cell: (c) => {
        const r = c.row.original;
        return (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || r.isDefault}
              onClick={() => {
                if (!window.confirm(`Delete plan "${r.name}"?`)) return;
                start(async () => {
                  const res = await deletePlan(r.id);
                  if (!res.ok) toast.error(res.error);
                  else {
                    toast.success("Plan deleted");
                    router.refresh();
                  }
                });
              }}
            >
              Delete
            </Button>
          </div>
        );
      },
    }),
  ] as Columns<PlanRow>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>New plan</Button>
      </div>
      <DataTable columns={columns} data={rows} empty="No plans." />
      {editing ? (
        <PlanDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
