"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const HEX = "0123456789abcdef";

function randomHash(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

/**
 * Hash-like machine text that ticks while `active` and settles on a stable value when the
 * operation ends. Static under prefers-reduced-motion. `settled` is shown when not active.
 */
export function HashTicker({
  active,
  settled,
  length = 16,
  className,
}: {
  active: boolean;
  /** Final value; defaults to a fixed placeholder of the same length. */
  settled?: string;
  length?: number;
  className?: string;
}) {
  const fixed = settled ?? "0".repeat(length);
  const [value, setValue] = useState(fixed);

  useEffect(() => {
    if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(fixed);
      return;
    }
    const id = setInterval(() => setValue(randomHash(length)), 90);
    return () => clearInterval(id);
  }, [active, fixed, length]);

  return (
    <span aria-hidden className={cn("font-mono text-xs tabular-nums", className)}>
      {value}
    </span>
  );
}

/** Deterministic short hash for a label, so a finished block always shows the same text. */
export function stableHash(input: string, length = 16): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  return hex.repeat(Math.ceil(length / 16)).slice(0, length);
}
