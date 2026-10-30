import { z } from "zod";
import { jobIdSchema } from "../agent-api.ts";
import { toolIdSchema, versionSchema } from "./catalog.ts";

/**
 * Worker <-> host agent contract for toolchain runs. The agent ships a static apply script into the
 * workspace and drives it with a validated plan; nothing here is ever interpolated into a shell.
 */

/** Bumped when `/opt/agentbox/env.sh` or the farm layout changes incompatibly. */
export const TOOLCHAIN_ENV_VERSION = 1;

/** mise backend: a core tool name or `<backend>:<owner/name>`. Options travel separately. */
export const backendSpecSchema = z
  .string()
  .regex(/^(?:node|bun|python|rust|go|java|[a-z]{2,10}:[A-Za-z0-9@/_.-]{1,120})$/);

/** Only these backend options exist; values are URL/checksum characters, never shell syntax. */
export const backendOptionsSchema = z
  .object({
    url: z.string().regex(/^https:\/\/[A-Za-z0-9._~:/?&=%+-]{1,600}$/),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .partial()
  .strict();

const binNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);

export const agentStepSchema = z
  .object({
    tool: toolIdSchema,
    action: z.enum(["install", "remove", "relink", "verify"]),
    /** Exact version for install/relink; registry installs may also say `latest` or a typed pin. */
    version: versionSchema.nullable(),
    backends: z
      .array(z.object({ spec: backendSpecSchema, options: backendOptionsSchema.optional() }))
      .max(3),
    /**
     * Registry tools (`mise:<name>`) have no known bins: the apply script links every executable of
     * the install and records the list in toolchain.json.
     */
    registry: z.boolean().optional(),
    bins: z
      .array(
        z.object({
          name: binNameSchema,
          file: binNameSchema.optional(),
          optional: z.boolean().default(false),
        }),
      )
      .max(8),
    versionArgs: z.array(z.string().regex(/^(?:-{1,2}[a-z][a-z-]*|version)$/)).max(3),
  })
  .superRefine((s, ctx) => {
    if ((s.action === "install" || s.action === "relink") && s.version === null)
      ctx.addIssue({ code: "custom", message: `${s.action} needs a version`, path: ["version"] });
    if (s.action === "install" && s.backends.length === 0)
      ctx.addIssue({ code: "custom", message: "install needs a backend", path: ["backends"] });
    if (!s.registry && s.bins.length === 0)
      ctx.addIssue({ code: "custom", message: "curated tools need bins", path: ["bins"] });
  });
export type AgentStep = z.infer<typeof agentStepSchema>;

/** POST /v1/workspaces/:ws/toolchain/apply (409 when the workspace is not running or a run is active) */
export const toolchainApplyRequestSchema = z.object({
  runId: jobIdSchema,
  mode: z.enum(["apply", "check"]),
  steps: z.array(agentStepSchema).max(48),
});
export type ToolchainApplyRequest = z.infer<typeof toolchainApplyRequestSchema>;

export const TOOLCHAIN_ERROR_CODES = [
  "quota",
  "version_not_found",
  "rate_limited",
  "integrity",
  "timeout",
  "smoke_failed",
  "missing_bin",
  "no_previous",
  "install_failed",
] as const;
export const toolchainErrorCodeSchema = z.enum(TOOLCHAIN_ERROR_CODES);
export type ToolchainErrorCode = z.infer<typeof toolchainErrorCodeSchema>;

/** One tool as recorded in `~/.agentbox/toolchain.json` (the observed state). */
export const observedToolSchema = z.object({
  version: z.string(),
  previous: z.string().nullable(),
  backend: z.string(),
  bins: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative(),
  installedAt: z.string(),
  /** First line of the post-install `--version` smoke test. */
  observed: z.string().nullable(),
});
export type ObservedTool = z.infer<typeof observedToolSchema>;

export const stepRecordSchema = z.object({
  tool: toolIdSchema,
  action: z.enum(["install", "remove", "relink", "verify"]),
  status: z.enum(["running", "ok", "failed", "skipped"]),
  version: z.string().nullish(),
  previous: z.string().nullish(),
  backend: z.string().nullish(),
  errorCode: toolchainErrorCodeSchema.nullish(),
  error: z.string().nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  /** verify: first line of `<bin> --version` and where the binary resolved. */
  observed: z.string().nullish(),
  path: z.string().nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;

export const toolchainResultSchema = z.object({
  exitCode: z.number().int(),
  finishedAt: z.string(),
  steps: z.array(stepRecordSchema),
  tools: z.record(z.string(), observedToolSchema),
});
export type ToolchainResult = z.infer<typeof toolchainResultSchema>;

/** GET /v1/workspaces/:ws/toolchain/runs/:runId?offset= */
export const toolchainRunResponseSchema = z.object({
  /** `interrupted`: no result and the script is gone (container stopped or restarted mid-run). */
  state: z.enum(["running", "finished", "interrupted", "missing"]),
  log: z.string(),
  nextOffset: z.number().int().nonnegative(),
  steps: z.array(stepRecordSchema),
  result: toolchainResultSchema.nullable(),
});
export type ToolchainRunResponse = z.infer<typeof toolchainRunResponseSchema>;
export const toolchainRunQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /v1/workspaces/:ws/toolchain/state */
export const toolchainStateResponseSchema = z.object({
  tools: z.record(z.string(), observedToolSchema),
  image: z.object({
    hasMise: z.boolean(),
    toolchainAbi: z.string().nullable(),
    envVersion: z.number().int().nullable(),
  }),
});
export type ToolchainStateResponse = z.infer<typeof toolchainStateResponseSchema>;
