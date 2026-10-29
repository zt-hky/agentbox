"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { grantUserAccess } from "@/app/admin/requests/actions";
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
import { grantSchema } from "@/lib/schemas";

export interface PlanOption {
  id: string;
  name: string;
  summary: string;
}

export interface GrantTarget {
  userId: string;
  email: string;
  suggestedSlug: string;
}

const formSchema = grantSchema.omit({ userId: true });

export function GrantAccessDialog({
  target,
  plans,
  defaultPlanId,
  baseDomain,
  onClose,
}: {
  target: GrantTarget;
  plans: PlanOption[];
  defaultPlanId: string;
  baseDomain: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { slug: target.suggestedSlug, planId: defaultPlanId },
  });
  const slug = form.watch("slug");
  const plan = plans.find((p) => p.id === form.watch("planId"));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {target.email}</DialogTitle>
          <DialogDescription>
            Gives the user access, assigns the plan and provisions their workspace.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) =>
              start(async () => {
                const res = await grantUserAccess({ ...values, userId: target.userId });
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success(`Approved. Provisioning workspace ${res.data.slug}`);
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
                  <FormLabel>Workspace name</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>
                    URL: {slug || "<name>"}-t3.{baseDomain}. Cannot be changed later.
                  </FormDescription>
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
                        <SelectValue placeholder="Choose a plan" />
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
                  {plan ? <FormDescription>{plan.summary}</FormDescription> : null}
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Approving…" : "Approve"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
