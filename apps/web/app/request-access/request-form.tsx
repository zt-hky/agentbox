"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { accessRequestSchema } from "@/lib/schemas";
import { checkRequestedSlug, submitAccessRequest } from "./actions";

const MODES = {
  request: { label: "What will you use AgentBox for? (optional)", submit: "Request access" },
  again: { label: "Anything the admin should know? (optional)", submit: "Request again" },
  note: { label: "Note for the admin (optional)", submit: "Save note" },
} as const;

const SLUG_DEBOUNCE_MS = 400;

type SlugAvailability = { state: "checking" } | { state: "ok" } | { state: "taken"; error: string };

function useSlugAvailability(slug: string): SlugAvailability {
  const [result, setResult] = useState<{ slug: string; availability: SlugAvailability } | null>(
    null,
  );
  useEffect(() => {
    const value = slug.trim();
    let cancelled = false;
    const id = setTimeout(async () => {
      const res = await checkRequestedSlug(value);
      if (cancelled) return;
      if (!res.ok) setResult({ slug: value, availability: { state: "taken", error: res.error } });
      else
        setResult({
          slug: value,
          availability: res.data.ok ? { state: "ok" } : { state: "taken", error: res.data.error },
        });
    }, SLUG_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [slug]);
  return result && result.slug === slug.trim() ? result.availability : { state: "checking" };
}

export function RequestForm({
  mode,
  initialMessage = "",
  initialSlug,
  baseDomain,
}: {
  mode: keyof typeof MODES;
  initialMessage?: string;
  initialSlug: string;
  baseDomain: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const form = useForm({
    resolver: zodResolver(accessRequestSchema),
    defaultValues: { slug: initialSlug, message: initialMessage },
  });
  const copy = MODES[mode];
  const slug = form.watch("slug");
  const slugAvailability = useSlugAvailability(slug);

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
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Workspace name</FormLabel>
              <FormControl>
                <Input autoComplete="off" spellCheck={false} {...field} />
              </FormControl>
              <FormDescription>
                Becomes your workspace ID and URL: {slug.trim() || "<name>"}-kcode.{baseDomain}. It
                cannot be changed later.
              </FormDescription>
              {slugAvailability.state === "ok" ? (
                <p className="text-meta text-muted-foreground" role="status">
                  Available.
                </p>
              ) : null}
              {slugAvailability.state === "taken" ? (
                <p className="text-meta text-destructive" role="status">
                  {slugAvailability.error}
                </p>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />
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
          disabled={
            pending ||
            slugAvailability.state === "taken" ||
            (mode === "note" && !form.formState.isDirty)
          }
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
