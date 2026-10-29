/** In-memory registry of running workspaces (rebuilt from podman at startup, see reconcile). */
export interface RunningWorkspace {
  ws: string;
  uid: number;
  slot: number;
  cgroupPath: string;
  imageId: string | null;
  startedAt: string;
}

export const registry = new Map<string, RunningWorkspace>();

/** Per-workspace serialization so stop/start/delete/stats-refresh never interleave. */
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}
