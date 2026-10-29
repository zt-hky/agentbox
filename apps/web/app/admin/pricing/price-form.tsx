"use client";

import { useTransition } from "react";
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
import { priceSchema } from "@/lib/schemas";
import { createPriceVersion } from "./actions";

type Values = z.input<typeof priceSchema>;

const FIELDS: { name: keyof Values; label: string }[] = [
  { name: "runtimePerHour", label: "Runtime per hour" },
  { name: "cpuCorePerHour", label: "CPU core per hour" },
  { name: "memGbPerHour", label: "Memory GB per hour" },
];

export function PriceForm({ initial, label }: { initial: Values; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm<Values>({ resolver: zodResolver(priceSchema), defaultValues: initial });
  return (
    <Form {...form}>
      <form
        className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start"
        onSubmit={form.handleSubmit((values) =>
          start(async () => {
            const res = await createPriceVersion(values);
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            toast.success("New price version is live");
            router.refresh();
          }),
        )}
      >
        {FIELDS.map((f) => (
          <FormField
            key={f.name}
            control={form.control}
            name={f.name}
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {f.label} ({label})
                </FormLabel>
                <FormControl>
                  <Input inputMode="decimal" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <Button type="submit" className="md:mt-[1.375rem]" disabled={pending}>
          Publish
        </Button>
      </form>
    </Form>
  );
}
