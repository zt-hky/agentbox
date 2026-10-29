/** Deterministic (UTC) so server render and hydration agree. */
export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "never";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "never";
  return d.toISOString().slice(0, 10);
}

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatHours(h: number): string {
  return `${h.toFixed(h >= 10 ? 0 : 2)} h`;
}
