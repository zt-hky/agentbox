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
import { Input } from "@/components/ui/input";
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

export function PlanControl({
  userId,
  planId,
  plans,
}: {
  userId: string;
  planId: string | null;
  plans: { id: string; name: string }[];
}) {
  const { pending, run } = useRun();
  const [value, setValue] = useState(planId ?? "");
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Plan</div>
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="No subscription" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        disabled={pending || !value || value === planId}
        onClick={() =>
          run(() => changeUserPlan(userId, value), "Plan changed; limits update queued")
        }
      >
        Change plan
      </Button>
    </div>
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
}: {
  label: string;
  target: GrantTarget;
  plans: PlanOption[];
  defaultPlanId: string;
  baseDomain: string;
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
