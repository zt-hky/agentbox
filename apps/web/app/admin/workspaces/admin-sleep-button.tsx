"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { adminStopWorkspace } from "./[slug]/actions";

export function AdminSleepButton({
  slug,
  status,
  ownerEmail,
  disabled = false,
}: {
  slug: string;
  status: string;
  ownerEmail: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const canSleep = status === "running" || status === "starting" || status === "error";
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline" disabled={disabled || !canSleep}>
          Sleep
        </Button>
      }
      title={`Sleep ${slug}?`}
      description={`Puts the workspace of ${ownerEmail} to sleep. Their open tabs disconnect; files stay.`}
      confirmLabel="Sleep workspace"
      onConfirm={async () => {
        const res = await adminStopWorkspace(slug);
        if (res.ok) {
          toast.success(`${slug} is going to sleep`);
          router.refresh();
        }
        return res;
      }}
    />
  );
}
