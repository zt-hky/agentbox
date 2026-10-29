import { z } from "zod";
import { MAX_DIAG_LOG_TAIL, MIN_DIAG_LOG_TAIL, processInfoSchema } from "./agent-api.ts";

/** `jobs.payload` / `jobs.result` of the diagnostic job types (enqueued by web, executed by the worker). */
export const fetchLogsPayloadSchema = z.object({
  tail: z.number().int().min(MIN_DIAG_LOG_TAIL).max(MAX_DIAG_LOG_TAIL),
});
export type FetchLogsPayload = z.infer<typeof fetchLogsPayloadSchema>;

export const fetchLogsResultSchema = z.object({ log: z.string(), fetchedAt: z.string() });
export type FetchLogsResult = z.infer<typeof fetchLogsResultSchema>;

export const inspectWorkspaceResultSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  processes: z.array(processInfoSchema),
  fetchedAt: z.string(),
});
export type InspectWorkspaceResult = z.infer<typeof inspectWorkspaceResultSchema>;
