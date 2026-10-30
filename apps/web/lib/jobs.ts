import { jobs } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";

export type StopReason =
  | "idle"
  | "max_awake"
  | "credits_exhausted"
  | "daily_limit"
  | "trial_ended"
  | "user"
  | "admin"
  | "suspended";

/** Enqueue a workspace job; the partial unique index dedupes queued/running duplicates. */
export async function enqueueWorkspaceJob(
  database: DbLike,
  workspaceId: string,
  job:
    | {
        type:
          | "provision_tenant"
          | "start_workspace"
          | "restart_workspace"
          | "update_limits"
          | "sync_git"
          | "sync_agent_keys"
          | "copilot_login";
      }
    | { type: "delete_tenant"; keepData?: boolean }
    | { type: "stop_workspace"; reason: StopReason },
): Promise<void> {
  const payload =
    job.type === "stop_workspace"
      ? { reason: job.reason }
      : job.type === "delete_tenant"
        ? { keepData: job.keepData === true }
        : {};
  await database
    .insert(jobs)
    .values({ type: job.type, workspaceId, payload })
    .onConflictDoNothing();
}
