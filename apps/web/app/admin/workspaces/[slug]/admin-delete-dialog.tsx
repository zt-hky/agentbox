"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChoiceCards } from "@/components/choice-cards";
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
import type { AdminAfterDelete } from "@/lib/admin/workspace-lifecycle";
import { adminDeleteWorkspace } from "./actions";

const DATA_MODES = [
  {
    value: true,
    title: "Keep data",
    detail:
      "Keeps the home folder: tool settings, agent and account config, and the code in /workspace. Re-creating the workspace under the same name reuses it.",
  },
  {
    value: false,
    title: "Wipe everything",
    detail: "Erases all files, settings, saved agent keys and tool choices. This cannot be undone.",
  },
] as const;

export function AdminDeleteWorkspaceDialog({
  slug,
  ownerEmail,
  ownerIsAdmin,
  disabled,
}: {
  slug: string;
  ownerEmail: string;
  ownerIsAdmin: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [afterDelete, setAfterDelete] = useState<AdminAfterDelete>("onboard");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ownerModes = [
    {
      value: "onboard",
      title: "Onboard again",
      detail: "The owner keeps access and goes through setup to create a new workspace.",
    },
    {
      value: "suspend",
      title: "Suspend the owner",
      detail: ownerIsAdmin
        ? "Admins are never suspended; they keep console access and onboard again."
        : "The owner loses access until an admin reactivates them; they onboard again then.",
    },
  ] as const;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
          setKeepData(true);
          setAfterDelete("onboard");
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={disabled}>
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete ${slug}?`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {`The container and Linux account for ${ownerEmail} are removed. Choose what happens to their data and their account.`}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ChoiceCards
          name="admin-delete-data"
          legend="Data"
          options={DATA_MODES}
          value={keepData}
          onChange={setKeepData}
          disabled={pending}
        />
        <ChoiceCards<AdminAfterDelete>
          name="admin-delete-owner"
          legend="Owner"
          options={ownerModes}
          value={afterDelete}
          onChange={setAfterDelete}
          disabled={pending}
        />
        <div className="grid gap-2">
          <Label htmlFor="admin-delete-typed">
            Type <span className="font-mono">{slug}</span> to confirm
          </Label>
          <Input
            id="admin-delete-typed"
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
                const res = await adminDeleteWorkspace(slug, {
                  confirm: typed,
                  keepData,
                  afterDelete,
                });
                if (res.ok) {
                  setOpen(false);
                  toast.success("Workspace deletion queued");
                  router.refresh();
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
