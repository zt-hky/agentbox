"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { DataTable, columnHelper, type Columns } from "@/components/data-table";
import { GrantAccessDialog, type PlanOption } from "@/components/grant-access-dialog";
import { StatusBadge } from "@/components/status-badge";
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
import { Textarea } from "@/components/ui/textarea";
import { rejectSchema } from "@/lib/schemas";
import { rejectRequest } from "./actions";

export interface AwaitingRow {
  userId: string;
  userName: string;
  email: string;
  accessStatus: string;
  requestId: string | null;
  message: string | null;
  since: string;
  suggestedSlug: string;
}

const rejectFormSchema = rejectSchema.omit({ requestId: true });

function RejectDialog({
  row,
  requestId,
  onClose,
}: {
  row: AwaitingRow;
  requestId: string;
  onClose: () => void;
}) {
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
          <DialogDescription>
            The reason is shown to the user, who can request again.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) =>
              start(async () => {
                const res = await rejectRequest({ ...values, requestId });
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
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
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

const h = columnHelper<AwaitingRow>();

export function RequestsTable({
  rows,
  plans,
  defaultPlanId,
  baseDomain,
}: {
  rows: AwaitingRow[];
  plans: PlanOption[];
  defaultPlanId: string;
  baseDomain: string;
}) {
  const [dialog, setDialog] = useState<{ kind: "approve" | "reject"; row: AwaitingRow } | null>(
    null,
  );
  const columns = [
    h.accessor("userName", {
      header: "User",
      cell: (c) => (
        <div>
          <Link
            href={`/admin/users/${c.row.original.userId}`}
            className="font-medium hover:underline"
          >
            {c.getValue()}
          </Link>
          <div className="text-meta text-muted-foreground">{c.row.original.email}</div>
        </div>
      ),
    }),
    h.accessor("accessStatus", {
      header: "Status",
      cell: (c) => <StatusBadge status={c.getValue()} />,
    }),
    h.accessor("message", {
      header: "Message",
      cell: (c) => (
        <span className="line-clamp-2 max-w-sm whitespace-normal text-muted-foreground">
          {c.getValue() ?? "No message"}
        </span>
      ),
    }),
    h.accessor("since", {
      header: "Since",
      cell: (c) => `${c.getValue().slice(0, 16).replace("T", " ")} UTC`,
    }),
    h.display({
      id: "actions",
      header: "",
      cell: (c) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setDialog({ kind: "approve", row: c.row.original })}>
            Approve
          </Button>
          {c.row.original.requestId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ kind: "reject", row: c.row.original })}
            >
              Reject
            </Button>
          ) : null}
        </div>
      ),
    }),
  ] as Columns<AwaitingRow>;

  return (
    <>
      <DataTable
        flush
        columns={columns}
        data={rows}
        empty="Nobody is waiting for access. New sign-ins appear here."
      />
      {dialog?.kind === "approve" ? (
        <GrantAccessDialog
          key={dialog.row.userId}
          target={dialog.row}
          plans={plans}
          defaultPlanId={defaultPlanId}
          baseDomain={baseDomain}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "reject" && dialog.row.requestId ? (
        <RejectDialog
          key={dialog.row.userId}
          row={dialog.row}
          requestId={dialog.row.requestId}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
