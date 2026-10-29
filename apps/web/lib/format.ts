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

/** "just now", "5 min ago", "3 h ago", "2 d ago". Pass `now` so server renders stay deterministic. */
export function formatAgo(d: Date | null | undefined, now: Date = new Date()): string {
  if (!d) return "never";
  const sec = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Compact duration: "42 s", "5 min", "3 h 12 min", "2 d 4 h". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
