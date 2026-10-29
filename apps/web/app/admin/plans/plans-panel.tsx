"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { KeyValueList } from "@/components/key-value-list";
import { PageHeader } from "@/components/page-header";
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
  FormDescription,
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
import { formatCredits, formatVnd } from "@/lib/money";
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
  inodesLimit: number;
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
  trialDays: number | null;
  dailyRuntimeHours: number | null;
  maxAwakeHours: number | null;
  idleTimeoutMinutes: number | null;
  sortOrder: number;
  public: boolean;
  active: boolean;
  isDefault: boolean;
}

type FormInput = z.input<typeof planSchema>;
type FormOutput = z.output<typeof planSchema>;

const NUMBER_FIELDS: { name: Path<FormInput>; label: string }[] = [
  { name: "cpuLimit", label: "CPU cores" },
  { name: "memoryLimitMb", label: "Memory (MB)" },
  { name: "diskLimitGb", label: "Disk (GB)" },
  { name: "pidsLimit", label: "Processes (pids)" },
  { name: "inodesLimit", label: "Files (inodes)" },
  { name: "allowanceRuntimeHours", label: "Allowance: runtime hours" },
  { name: "allowanceCpuCoreHours", label: "Allowance: CPU core-hours" },
  { name: "allowanceMemGbHours", label: "Allowance: memory GB-hours" },
  { name: "trialDays", label: "Trial length (days, blank = none)" },
  { name: "dailyRuntimeHours", label: "Daily runtime cap (h, blank = none)" },
  { name: "maxAwakeHours", label: "Max continuous awake (h, blank = global)" },
  { name: "idleTimeoutMinutes", label: "Idle sleep after (min, blank = global)" },
  { name: "sortOrder", label: "Sort order" },
];

const blank = (v: number | null) => (v === null ? "" : String(v));

function PlanDialog({
  row,
  label,
  creditValueVnd,
  onClose,
}: {
  row: PlanRow | null;
  label: string;
  creditValueVnd: number;
  onClose: () => void;
}) {
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
          inodesLimit: String(row.inodesLimit),
          allowanceRuntimeHours: String(row.allowanceRuntimeHours),
          allowanceCpuCoreHours: String(row.allowanceCpuCoreHours),
          allowanceMemGbHours: String(row.allowanceMemGbHours),
          trialDays: blank(row.trialDays),
          dailyRuntimeHours: blank(row.dailyRuntimeHours),
          maxAwakeHours: blank(row.maxAwakeHours),
          idleTimeoutMinutes: blank(row.idleTimeoutMinutes),
          sortOrder: String(row.sortOrder),
          public: row.public,
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
          inodesLimit: "4000000",
          allowanceRuntimeHours: "0",
          allowanceCpuCoreHours: "0",
          allowanceMemGbHours: "0",
          trialDays: "",
          dailyRuntimeHours: "",
          maxAwakeHours: "",
          idleTimeoutMinutes: "",
          sortOrder: "10",
          public: true,
          active: true,
        },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{row ? `Edit ${row.name}` : "New plan"}</DialogTitle>
          <DialogDescription>
            Changing limits queues an update for workspaces on this plan. Disk, files and processes
            apply at once; running containers keep their old CPU and memory until they restart.
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
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="package">Package</SelectItem>
                      <SelectItem value="payg">Credits only</SelectItem>
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
                  <FormLabel>Monthly price ({label}s)</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" {...field} />
                  </FormControl>
                  <FormDescription>
                    1 {label} = {formatVnd(creditValueVnd)}
                  </FormDescription>
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
              name="public"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 sm:col-span-2">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(c) => field.onChange(c === true)}
                    />
                  </FormControl>
                  <FormLabel>Public (shown to users and on the landing page)</FormLabel>
                </FormItem>
              )}
            />
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

const KIND_LABEL: Record<PlanRow["kind"], string> = {
  free: "Free",
  package: "Package",
  payg: "Credits only",
};

const hours = (h: number) => `${+h.toFixed(2)} h`;

function PlanCard({
  row,
  label,
  creditValueVnd,
  onEdit,
  onDeleted,
}: {
  row: PlanRow;
  label: string;
  creditValueVnd: number;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const price = BigInt(Math.round(Number(row.monthlyPrice) * 1_000_000));
  return (
    <article className="flex flex-col rounded-lg border bg-card text-card-foreground">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base">
            {row.name}
            {row.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            {row.public ? null : <Badge variant="outline">Internal</Badge>}
            {row.active ? null : <Badge variant="outline">Inactive</Badge>}
          </h2>
          <p className="mt-0.5 text-meta text-muted-foreground">
            {KIND_LABEL[row.kind]} · order {row.sortOrder}
          </p>
        </div>
        <p className="text-right text-sm font-medium">
          {price > 0n ? `${formatCredits(price, label, creditValueVnd)} / month` : "No monthly fee"}
        </p>
      </header>
      <div className="flex-1 space-y-4 p-5">
        <KeyValueList
          items={[
            { label: "vCPU", value: row.cpuLimit },
            { label: "Memory", value: `${+(row.memoryLimitMb / 1024).toFixed(2)} GB` },
            { label: "Disk", value: `${row.diskLimitGb} GB` },
            { label: "Files", value: row.inodesLimit.toLocaleString("en-US") },
            { label: "Processes", value: row.pidsLimit.toLocaleString("en-US") },
            {
              label: "Included",
              value: `${hours(row.allowanceRuntimeHours)} runtime, ${+row.allowanceCpuCoreHours.toFixed(1)} core-h, ${+row.allowanceMemGbHours.toFixed(1)} GB-h`,
            },
            { label: "Trial", value: row.trialDays ? `${row.trialDays} days` : "none" },
            {
              label: "Daily cap",
              value:
                row.dailyRuntimeHours === null ? "none" : `${hours(row.dailyRuntimeHours)} a day`,
            },
            {
              label: "Idle sleep",
              value: row.idleTimeoutMinutes === null ? "global" : `${row.idleTimeoutMinutes} min`,
            },
            {
              label: "Max awake",
              value: row.maxAwakeHours === null ? "global" : hours(row.maxAwakeHours),
            },
          ]}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline" disabled={row.isDefault}>
                Delete
              </Button>
            }
            title={`Delete plan "${row.name}"?`}
            description="A plan with subscribers cannot be deleted; deactivate it instead."
            confirmLabel="Delete plan"
            destructive
            onConfirm={async () => {
              const res = await deletePlan(row.id);
              if (res.ok) {
                toast.success("Plan deleted");
                onDeleted();
              }
              return res;
            }}
          />
        </div>
      </div>
    </article>
  );
}

export function PlansPanel({
  rows,
  label,
  creditValueVnd,
}: {
  rows: PlanRow[];
  label: string;
  creditValueVnd: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const sorted = [...rows].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  return (
    <>
      <PageHeader
        title="Plans"
        description={`Limits apply to each subscriber's workspace. Prices are in ${label}s per month (1 ${label} = ${formatVnd(creditValueVnd)}). Public plans are shown to users in display order.`}
        actions={<Button onClick={() => setEditing("new")}>New plan</Button>}
      />
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No plans yet. Create one to assign to users.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sorted.map((r) => (
            <PlanCard
              key={r.id}
              row={r}
              label={label}
              creditValueVnd={creditValueVnd}
              onEdit={() => setEditing(r)}
              onDeleted={() => router.refresh()}
            />
          ))}
        </div>
      )}
      {editing ? (
        <PlanDialog
          row={editing === "new" ? null : editing}
          label={label}
          creditValueVnd={creditValueVnd}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
