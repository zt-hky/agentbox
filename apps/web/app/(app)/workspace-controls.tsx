"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChoiceCards } from "@/components/choice-cards";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Notice } from "@/components/notice";
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
import { deleteWorkspaceAction, restartNow } from "./actions";

export function RestartButton() {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={<Button variant="outline">Restart</Button>}
      title="Restart your workspace?"
      description="Stops the machine and starts it again. Running processes and open terminals end; your files stay."
      confirmLabel="Restart"
      onConfirm={async () => {
        const res = await restartNow();
        if (res.ok) {
          toast.success("Workspace is restarting");
          router.refresh();
        }
        return res;
      }}
    />
  );
}

const MODES = [
  {
    value: true,
    title: "Delete the machine, keep my data",
    detail:
      "Keeps your home folder: tool settings, agent and account config, and the code in /workspace. Setup runs again and reuses it.",
  },
  {
    value: false,
    title: "Delete everything",
    detail: "Erases all files, settings, saved agent keys and tool choices. This cannot be undone.",
  },
] as const;

export function DeleteWorkspaceButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
          setKeepData(true);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete workspace</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete your workspace?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              Your workspace stops and is removed. You will go through setup again to create a new
              one.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ChoiceCards
          name="delete-mode"
          legend="What happens to your data"
          options={MODES}
          value={keepData}
          onChange={setKeepData}
          disabled={pending}
        />
        <div className="grid gap-2">
          <Label htmlFor="delete-typed">
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input
            id="delete-typed"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={typed !== slug || pending}
            onClick={() =>
              start(async () => {
                const res = await deleteWorkspaceAction({ keepData, confirmSlug: typed });
                if (res.ok) {
                  setOpen(false);
                  router.replace(res.data.redirectTo);
                } else setError(res.error);
              })
            }
          >
            {keepData ? "Delete, keep data" : "Delete everything"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
