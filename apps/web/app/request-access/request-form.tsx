"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { RefreshCw } from "lucide-react";
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

const MODES = {
  request: { label: "What will you use AgentBox for? (optional)", submit: "Request access" },
  again: { label: "Anything the admin should know? (optional)", submit: "Request again" },
  note: { label: "Note for the admin (optional)", submit: "Save note" },
} as const;

export function RequestForm({
  mode,
  initialMessage = "",
}: {
  mode: keyof typeof MODES;
  initialMessage?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm({
    resolver: zodResolver(accessRequestSchema),
    defaultValues: { message: initialMessage },
  });
  const copy = MODES[mode];

  return (
    <Form {...form}>
      <form
        className="space-y-3"
        onSubmit={form.handleSubmit((values) =>
          start(async () => {
            const res = await submitAccessRequest(values);
            if (!res.ok) toast.error(res.error);
            else {
              toast.success(mode === "note" ? "Note saved" : "Request sent to the admins");
              form.reset(values);
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
              <FormLabel>{copy.label}</FormLabel>
              <FormControl>
                <Textarea rows={3} placeholder="e.g. team, project, expected usage" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          variant={mode === "note" ? "outline" : "default"}
          disabled={pending || (mode === "note" && !form.formState.isDirty)}
        >
          {copy.submit}
        </Button>
      </form>
    </Form>
  );
}

const RECHECK_MS = 30_000;

/** Re-renders the page periodically; once approved, the server redirects to the dashboard. */
export function ApprovalWatcher() {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Polls the server for an approval made by an admin elsewhere.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), RECHECK_MS);
    return () => clearInterval(id);
  }, [router]);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => start(() => router.refresh())}
    >
      <RefreshCw className="size-4" />
      Check again
    </Button>
  );
}
