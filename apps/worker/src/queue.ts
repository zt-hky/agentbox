import { jobs, workspaceEvents } from "@agentbox/db/schema";
import type { Executor } from "./types.ts";

type JobType = (typeof jobs.$inferInsert)["type"];
type EventType = (typeof workspaceEvents.$inferInsert)["type"];

/** Insert a job; the partial unique index (workspace_id, type) dedupes queued/running ones. */
export async function enqueueJob(
  ex: Executor,
  job: { type: JobType; workspaceId: string | null; payload?: unknown },
): Promise<boolean> {
  const rows = await ex
    .insert(jobs)
    .values({ type: job.type, workspaceId: job.workspaceId, payload: job.payload ?? {} })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function addEvent(
  ex: Executor,
  workspaceId: string,
  type: EventType,
  details?: unknown,
): Promise<void> {
  await ex.insert(workspaceEvents).values({ workspaceId, type, details: details ?? null });
}
