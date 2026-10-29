"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { accessRequestSchema } from "@/lib/schemas";
import { submitAccessRequest } from "./actions";

export function RequestForm({ again }: { again: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm({
    resolver: zodResolver(accessRequestSchema),
    defaultValues: { message: "" },
  });

  return (
    <Form {...form}>
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit((values) =>
          start(async () => {
            const res = await submitAccessRequest(values);
            if (!res.ok) toast.error(res.error);
            else {
              toast.success("Request submitted");
              router.refresh();
            }
          }),
        )}
      >
        <FormField
          control={form.control}
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel>What will you use AgentBox for? (optional)</FormLabel>
              <FormControl>
                <Textarea rows={4} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={pending}>
          {again ? "Request again" : "Request access"}
        </Button>
      </form>
    </Form>
  );
}
