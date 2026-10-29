"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import {
  billingSettingsSchema,
  capacitySettingsSchema,
  hibernationSettingsSchema,
  type BillingSettings,
  type CapacitySettings,
  type HibernationSettings,
  type SettingKey,
} from "@agentbox/core/settings";
import { Section } from "@/components/section";
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
import { saveSetting } from "./actions";

function useSave<T extends FieldValues>(key: SettingKey) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (values: T) =>
    start(async () => {
      const res = await saveSetting(key, values);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Settings saved");
        router.refresh();
      }
    });
  return { pending, submit };
}

function NumberField<T extends FieldValues>({
  form,
  name,
  label,
  step,
}: {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  step?: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={() => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              step={step ?? "any"}
              {...form.register(name, { valueAsNumber: true })}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function HibernationForm({ initial }: { initial: HibernationSettings }) {
  const form = useForm<HibernationSettings>({
    resolver: zodResolver(hibernationSettingsSchema),
    defaultValues: initial,
  });
  const { pending, submit } = useSave<HibernationSettings>("hibernation");
  return (
    <Section
      title="Hibernation"
      description="A workspace is idle when no request arrived, CPU and network stay below the thresholds, for the timeout. Max awake hours of 0 disables the cap."
    >
      <Form {...form}>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={form.handleSubmit(submit)}>
          <NumberField form={form} name="idleTimeoutMinutes" label="Idle timeout (minutes)" />
          <NumberField form={form} name="idleCpuPercent" label="Idle CPU threshold (%)" />
          <NumberField
            form={form}
            name="idleNetBytesPerMin"
            label="Idle network threshold (bytes/min)"
          />
          <NumberField form={form} name="maxAwakeHours" label="Max awake hours" />
          <div>
            <Button type="submit" disabled={pending}>
              Save hibernation
            </Button>
          </div>
        </form>
      </Form>
    </Section>
  );
}

function CapacityForm({ initial }: { initial: CapacitySettings }) {
  const form = useForm<CapacitySettings>({
    resolver: zodResolver(capacitySettingsSchema),
    defaultValues: initial,
  });
  const { pending, submit } = useSave<CapacitySettings>("capacity");
  return (
    <Section
      title="Capacity"
      description="Wake-ups are refused when running workspaces' memory limits would exceed this fraction of host memory."
    >
      <Form {...form}>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={form.handleSubmit(submit)}>
          <NumberField
            form={form}
            name="maxRunningMemoryRatio"
            label="Max running memory ratio (0-1)"
            step="0.01"
          />
          <div className="md:col-span-2">
            <Button type="submit" disabled={pending}>
              Save capacity
            </Button>
          </div>
        </form>
      </Form>
    </Section>
  );
}

function BillingForm({
  initial,
  plans,
}: {
  initial: BillingSettings | null;
  plans: { id: string; name: string }[];
}) {
  const form = useForm<z.input<typeof billingSettingsSchema>>({
    resolver: zodResolver(billingSettingsSchema),
    defaultValues: initial ?? {
      creditLabel: "credit",
      defaultPlanId: plans[0]?.id ?? "",
      creditValueVnd: 1000,
    },
  });
  const { pending, submit } = useSave<z.input<typeof billingSettingsSchema>>("billing");
  return (
    <Section
      title="Billing"
      description="The credit label and its value in dong are for display. The default plan is the fallback when no plan is chosen."
    >
      <Form {...form}>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={form.handleSubmit(submit)}>
          <FormField
            control={form.control}
            name="creditLabel"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Credit label</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="defaultPlanId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default plan</FormLabel>
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
          <FormField
            control={form.control}
            name="creditValueVnd"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Value of one credit (₫)</FormLabel>
                <FormControl>
                  <Input
                    inputMode="numeric"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={String(field.value ?? "")}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="md:col-span-2">
            <Button type="submit" disabled={pending}>
              Save billing
            </Button>
          </div>
        </form>
      </Form>
    </Section>
  );
}

export function SettingsForms(props: {
  hibernation: HibernationSettings;
  capacity: CapacitySettings;
  billing: BillingSettings | null;
  plans: { id: string; name: string }[];
}) {
  return (
    <>
      <HibernationForm initial={props.hibernation} />
      <CapacityForm initial={props.capacity} />
      <BillingForm initial={props.billing} plans={props.plans} />
    </>
  );
}
