import { lstat, readdir } from "node:fs/promises";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { TENANTS_DIR } from "./config.ts";
import { errMessage, logEvent } from "./log.ts";
import { ensurePodmanSocket } from "./monitor.ts";
import { tenantUser } from "./argv.ts";
import { isTenantUid, slotOfUid } from "./safe.ts";
import { registry } from "./state.ts";
import { userManagerUp } from "./tenants.ts";
import { containerRunning, inspectContainer, stopContainer } from "./workspaces.ts";

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++] as T);
    }),
  );
}

/** Rebuild the running-workspace registry from podman (containers survive agent restarts). */
export async function reconcile(): Promise<void> {
  const names = await readdir(TENANTS_DIR).catch(() => [] as string[]);
  await mapLimit(names, 8, async (ws) => {
    if (!wsSlugSchema.safeParse(ws).success) return;
    try {
      const st = await lstat(`${TENANTS_DIR}/${ws}`);
      if (!isTenantUid(st.uid) || !(await userManagerUp(st.uid))) return;
      if (!(await containerRunning(ws, st.uid))) return;
      const info = await inspectContainer(ws);
      registry.set(ws, {
        ws,
        uid: st.uid,
        slot: slotOfUid(st.uid),
        cgroupPath: info.cgroupPath,
        imageId: info.imageId,
        startedAt: info.startedAt ?? new Date().toISOString(),
      });
      await ensurePodmanSocket(tenantUser(ws));
      logEvent({ ws, event: "reconciled", imageId: info.imageId ?? undefined });
    } catch (e) {
      logEvent({ ws, event: "reconcile_failed", error: errMessage(e) });
    }
  });
}

/** SIGTERM: stop every running workspace in parallel (20 s each). */
export async function stopAll(): Promise<void> {
  await Promise.all(
    [...registry.values()].map(async (w) => {
      const t0 = Date.now();
      try {
        const exitCode = await stopContainer(w.ws, w.uid);
        logEvent({
          ws: w.ws,
          event: "stopped",
          imageId: w.imageId ?? undefined,
          exitCode,
          durationMs: Date.now() - t0,
        });
      } catch (e) {
        logEvent({ ws: w.ws, event: "stop_failed", error: errMessage(e) });
      }
    }),
  );
}
