export const $ = <T extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T | null => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T[] => Array.from(root.querySelectorAll<T>(sel));
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const MQ = {
  motion: "(prefers-reduced-motion: no-preference)",
  wide: "(min-width: 768px) and (min-height: 561px)",
  short: "(max-height: 560px) and (orientation: landscape)",
  narrow: "(max-width: 767px)",
  smooth: "(pointer: fine) and (min-width: 768px) and (prefers-reduced-motion: no-preference)",
} as const;
