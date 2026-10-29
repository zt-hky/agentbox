"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { approveSchema, rejectSchema } from "@/lib/schemas";
import { approveRequest, rejectRequest } from "./actions";

export interface PendingRow {
  id: string;
  userName: string;
  email: string;
  message: string | null;
  createdAt: string;
  suggestedSlug: string;
}
export interface PlanOption {
  id: string;
  name: string;
}

const approveFormSchema = approveSchema.omit({ requestId: true });
const rejectFormSchema = rejectSchema.omit({ requestId: true });

function ApproveDialog({
  row,
  plans,
  defaultPlanId,
  onClose,
}: {
  row: PendingRow;
  plans: PlanOption[];
  defaultPlanId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof approveFormSchema>>({
    resolver: zodResolver(approveFormSchema),
    defaultValues: { slug: row.suggestedSlug, planId: defaultPlanId },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {row.email}</DialogTitle>
          <DialogDescription>
            Creates the workspace and starts provisioning. The slug becomes the workspace host
            prefix and cannot be changed later.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) =>
              start(async () => {
                const res = await approveRequest({ ...values, requestId: row.id });
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success(`Approved; provisioning ${res.data.slug}`);
                onClose();
                router.refresh();
              }),
            )}
          >
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Workspace slug</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="planId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                Approve
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ row, onClose }: { row: PendingRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof rejectFormSchema>>({
    resolver: zodResolver(rejectFormSchema),
    defaultValues: { reason: "" },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject {row.email}</DialogTitle>
          <DialogDescription>The reason is shown to the user.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) =>
              start(async () => {
                const res = await rejectRequest({ ...values, requestId: row.id });
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success("Request rejected");
                onClose();
                router.refresh();
              }),
            )}
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={pending}>
                Reject
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const h = columnHelper<PendingRow>();

export function RequestsTable({
  rows,
  plans,
  defaultPlanId,
}: {
  rows: PendingRow[];
  plans: PlanOption[];
  defaultPlanId: string;
}) {
  const [dialog, setDialog] = useState<{ kind: "approve" | "reject"; row: PendingRow } | null>(
    null,
  );
  const columns = [
    h.accessor("userName", {
      header: "User",
      cell: (c) => (
        <div>
          <div className="font-medium">{c.getValue()}</div>
          <div className="text-xs text-muted-foreground">{c.row.original.email}</div>
        </div>
      ),
    }),
    h.accessor("message", {
      header: "Message",
      cell: (c) => (
        <span className="line-clamp-2 max-w-sm whitespace-normal">{c.getValue() ?? ""}</span>
      ),
    }),
    h.accessor("createdAt", {
      header: "Submitted",
      cell: (c) => c.getValue().slice(0, 16).replace("T", " "),
    }),
    h.display({
      id: "actions",
      header: "",
      cell: (c) => (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setDialog({ kind: "approve", row: c.row.original })}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog({ kind: "reject", row: c.row.original })}
          >
            Reject
          </Button>
        </div>
      ),
    }),
  ] as Columns<PendingRow>;

  return (
    <>
      <DataTable columns={columns} data={rows} empty="No pending requests." />
      {dialog?.kind === "approve" ? (
        <ApproveDialog
          key={dialog.row.id}
          row={dialog.row}
          plans={plans}
          defaultPlanId={defaultPlanId}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "reject" ? (
        <RejectDialog key={dialog.row.id} row={dialog.row} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}
