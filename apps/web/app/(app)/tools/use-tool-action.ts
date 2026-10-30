"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";

/** Runs a server action, toasts its outcome and refreshes the page data. */
export function useToolAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, success: string) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  /** For ConfirmDialog: returns the result so the dialog can show an error. */
  const confirm = (fn: () => Promise<ActionResult<unknown>>, success: string) => async () => {
    const res = await fn();
    if (res.ok) {
      toast.success(success);
      router.refresh();
    }
    return res;
  };
  return { pending, run, confirm };
}
