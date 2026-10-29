"use client";

import { useState, useTransition } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/notice";
import type { ActionResult } from "@/lib/action";

/**
 * Confirm before a consequential action. `onConfirm` may return a server-action result: on
 * `{ ok: false }` the dialog stays open and shows the error. Set `confirmText` (for example the
 * workspace slug) to require typing it before the button enables.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  confirmText,
  onConfirm,
}: {
  /** A single button element; rendered with `asChild`. */
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  confirmText?: string;
  onConfirm: () => Promise<ActionResult<unknown> | void> | ActionResult<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = confirmText === undefined || typed === confirmText;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {confirmText !== undefined ? (
          <div className="grid gap-2">
            <Label htmlFor="confirm-typed">
              Type <span className="font-mono">{confirmText}</span> to confirm
            </Label>
            <Input
              id="confirm-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!ready || pending}
            onClick={() =>
              start(async () => {
                const res = await onConfirm();
                if (res && !res.ok) setError(res.error);
                else setOpen(false);
              })
            }
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
