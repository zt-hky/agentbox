"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GrantAccessDialog,
  type GrantTarget,
  type PlanOption,
} from "@/components/grant-access-dialog";
import { formatCredits } from "@/lib/money";
import { creditAdjustSchema } from "@/lib/schemas";
import {
  adjustUserCredits,
  changeUserPlan,
  reactivateUser,
  setUserRole,
  suspendUser,
} from "./actions";

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(success);
        router.refresh();
      }
    });
  return { pending, run };
}

export function RoleControl({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role: string;
  isSelf: boolean;
}) {
  const { pending, run } = useRun();
  const [value, setValue] = useState<"user" | "admin">(role === "admin" ? "admin" : "user");
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Role</div>
        <Select
          value={value}
          onValueChange={(v) => setValue(v as "user" | "admin")}
          disabled={isSelf}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">user</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        disabled={pending || isSelf || value === (role === "admin" ? "admin" : "user")}
        onClick={() => run(() => setUserRole(userId, value), "Role updated")}
      >
        Save role
      </Button>
    </div>
  );
}

export interface PlanChoice {
  id: string;
  name: string;
  summary: string;
  kind: "free" | "package" | "payg";
  monthlyPriceMicro: string;
}

/** Plan picker + dialog: package plans can charge the first month now or waive it. */
export function PlanControl({
  userId,
  planId,
  plans,
  balanceMicro,
  label,
  creditValueVnd,
  defaultOpen = false,
}: {
  userId: string;
  planId: string | null;
  plans: PlanChoice[];
  balanceMicro: string;
  label: string;
  creditValueVnd: number;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [pending, start] = useTransition();
  const [value, setValue] = useState(plans.find((p) => p.id !== planId)?.id ?? "");
  const [fee, setFee] = useState<"charge" | "waive">("charge");
  const current = plans.find((p) => p.id === planId);
  const chosen = plans.find((p) => p.id === value);
  const price = chosen && chosen.kind === "package" ? BigInt(chosen.monthlyPriceMicro) : 0n;
  const balance = BigInt(balanceMicro);
  const short = fee === "charge" && price > balance;
  return (
    <>
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Plan</div>
        <div className="flex items-center gap-2">
          <span className="min-w-32 text-sm">{current?.name ?? "No subscription"}</span>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Change plan
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change plan</DialogTitle>
            <DialogDescription>
              Starts a new cycle with fresh usage counters and queues a limits update. Running
              containers keep their old CPU and memory until they restart.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>New plan</Label>
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans
                    .filter((p) => p.id !== planId)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {chosen ? <p className="text-meta text-muted-foreground">{chosen.summary}</p> : null}
            </div>
            {price > 0n ? (
              <div
                role="radiogroup"
                aria-label="First month fee"
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <p className="text-meta text-muted-foreground">
                  First month {formatCredits(price, label, creditValueVnd)}. Balance{" "}
                  {formatCredits(balance, label, creditValueVnd)}.
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="fee"
                    className="mt-1"
                    checked={fee === "charge"}
                    onChange={() => setFee("charge")}
                  />
                  <span>
                    <span className="font-medium">Charge first month now</span>
                    <span className="block text-meta text-muted-foreground">
                      Debits the credit balance (ledger: package fee).
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="fee"
                    className="mt-1"
                    checked={fee === "waive"}
                    onChange={() => setFee("waive")}
                  />
                  <span>
                    <span className="font-medium">Waive this month&apos;s fee</span>
                    <span className="block text-meta text-muted-foreground">
                      No charge; recorded in the audit log. Renewal is charged normally.
                    </span>
                  </span>
                </label>
                {short ? (
                  <p role="alert" className="text-meta text-destructive">
                    The balance is too low for the first month. Top up first or waive the fee.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !value || short}
              onClick={() =>
                start(async () => {
                  const res = await changeUserPlan({ userId, planId: value, fee });
                  if (!res.ok) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success("Plan changed; limits update queued");
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              Change plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AccessControl({
  userId,
  accessStatus,
  isSelf,
}: {
  userId: string;
  accessStatus: string;
  isSelf: boolean;
}) {
  const { pending, run } = useRun();
  if (accessStatus === "suspended") {
    return (
      <Button
        disabled={pending}
        onClick={() => run(() => reactivateUser(userId), "User reactivated")}
      >
        Reactivate
      </Button>
    );
  }
  return (
    <Button
      variant="destructive"
      disabled={pending || isSelf}
      onClick={() => run(() => suspendUser(userId), "User suspended")}
    >
      Suspend
    </Button>
  );
}

/** For users without a workspace: one step gives access, a plan and a workspace. */
export function ApproveUserButton({
  label,
  target,
  plans,
  defaultPlanId,
  baseDomain,
  mode,
}: {
  label: string;
  target: GrantTarget;
  plans: PlanOption[];
  defaultPlanId: string;
  baseDomain: string;
  mode?: "grant" | "recreate";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      {open ? (
        <GrantAccessDialog
          target={target}
          plans={plans}
          defaultPlanId={defaultPlanId}
          baseDomain={baseDomain}
          mode={mode}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function CreditsForm({ userId, label }: { userId: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof creditAdjustSchema>>({
    resolver: zodResolver(creditAdjustSchema),
    defaultValues: { userId, direction: "add", amount: "", note: "" },
  });
  return (
    <Form {...form}>
      <form
        className="grid gap-4 md:grid-cols-[10rem_10rem_1fr_auto] md:items-start"
        onSubmit={form.handleSubmit((values) =>
          start(async () => {
            const res = await adjustUserCredits(values);
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            toast.success("Credits updated");
            form.reset({ userId, direction: values.direction, amount: "", note: "" });
            router.refresh();
          }),
        )}
      >
        <FormField
          control={form.control}
          name="direction"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Action</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="add">Add (top-up)</SelectItem>
                  <SelectItem value="remove">Remove (adjustment)</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="amount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Amount ({label})</FormLabel>
              <FormControl>
                <Input inputMode="decimal" placeholder="5.00" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="note"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Note (required)</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="md:mt-[1.375rem]" disabled={pending}>
          Apply
        </Button>
      </form>
    </Form>
  );
}
