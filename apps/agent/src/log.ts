/**
 * One JSON line per lifecycle event on stdout. Callers pass only identifiers, exit codes and
 * durations; never tokens, env values or request bodies.
 */
export interface LifecycleEvent {
  ws?: string;
  event: string;
  imageId?: string;
  exitCode?: number | null;
  durationMs?: number;
  [extra: string]: string | number | boolean | null | undefined;
}

export function logEvent(e: LifecycleEvent): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`);
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
