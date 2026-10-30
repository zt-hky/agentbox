"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { checkForUpdatesAction, upgradeAllAction } from "./actions";
import { useToolAction } from "./use-tool-action";

export function HeaderActions({
  upgradable,
  asleep,
}: {
  /** Tools with a newer version on their channel. */
  upgradable: number;
  asleep: boolean;
}) {
  const { pending, run, confirm } = useToolAction();
  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => run(checkForUpdatesAction, "Version check finished")}
      >
        Check for updates
      </Button>
      <ConfirmDialog
        trigger={<Button disabled={pending || upgradable === 0}>Upgrade all</Button>}
        title={`Upgrade ${upgradable} ${upgradable === 1 ? "tool" : "tools"}?`}
        description={
          asleep
            ? "The workspace is asleep: applying starts it, billed as normal awake time, and the idle policy stops it afterwards."
            : "Each installed tool moves to the newest version on its channel. The current version is kept so you can roll back."
        }
        confirmLabel="Upgrade all"
        onConfirm={confirm(upgradeAllAction, "Upgrade queued")}
      />
    </>
  );
}
