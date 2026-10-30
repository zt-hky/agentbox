"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { disconnectGithub } from "./actions";

export function DisconnectButton() {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={<Button variant="outline">Disconnect GitHub</Button>}
      title="Disconnect GitHub?"
      description="The token is revoked at GitHub. gh is logged out and its git credential helper is removed from your workspace. A Copilot sign-in made from this page is signed out as well."
      confirmLabel="Disconnect"
      destructive
      onConfirm={async () => {
        const res = await disconnectGithub();
        if (res.ok) {
          toast.success("GitHub disconnected");
          router.refresh();
        }
        return res;
      }}
    />
  );
}
