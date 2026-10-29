import Image from "next/image";
import { cn } from "@/lib/utils";

/** The AgentBox mark: a dark cube whose top face is a slot of Iris → Aurora light. */
export function Logo({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/mark.svg"
      alt=""
      width={64}
      height={64}
      unoptimized
      className={cn("size-6", className)}
    />
  );
}
