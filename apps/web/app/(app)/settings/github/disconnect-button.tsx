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
      description="The token is revoked at GitHub and removed from your workspace's gh and git setup."
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
