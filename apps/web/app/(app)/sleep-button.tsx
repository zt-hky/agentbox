"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { sleepNow } from "./actions";

export function SleepButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="lg"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await sleepNow();
          if (!res.ok) toast.error(res.error);
          else {
            toast.success("Workspace is going to sleep");
            router.refresh();
          }
        })
      }
    >
      Sleep now
    </Button>
  );
}
