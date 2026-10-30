import { z } from "zod";
import { gitProviderIdSchema } from "./git.ts";
import { imageManifestSchema } from "./toolchain/gate.ts";

/** Route params */
export const wsSlugSchema = z.string().regex(/^[a-z][a-z0-9]{2,19}$/);
export const imageIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const jobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const wsParamsSchema = z.object({ ws: wsSlugSchema });
export const imageParamsSchema = z.object({ imageId: imageIdSchema });
export const jobParamsSchema = z.object({ jobId: jobIdSchema });
export const logQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(10000).default(200),
});

const slotSchema = z.number().int().min(1).max(4999);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const tenantLimitsSchema = z.object({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  /** XFS inode hard limit (`ihard`). */
  inodes: z.number().int().positive().default(4_000_000),
});
export type TenantLimits = z.infer<typeof tenantLimitsSchema>;

/** DELETE /v1/tenants/:ws?keepData=1: keep the tenant home (configs, /workspace) instead of wiping it. */
export const deleteTenantQuerySchema = z.object({
  keepData: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});

/** PUT /v1/workspaces/:ws/agent-keys: the complete set of agent credentials (env var -> value). */
export const AGENT_KEYS_MAX = 32;
export const agentKeysRequestSchema = z.object({
  keys: z
    .record(
      z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\s\p{Cc}]+$/u),
    )
    .refine((k) => Object.keys(k).length <= AGENT_KEYS_MAX, "too many keys"),
});
export type AgentKeysRequest = z.infer<typeof agentKeysRequestSchema>;

/** POST /v1/tenants */
export const createTenantRequestSchema = z.object({
  ws: wsSlugSchema,
  slot: slotSchema,
  diskGb: z.number().int().positive(),
  limits: tenantLimitsSchema,
});
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

/** PUT /v1/tenants/:ws/limits */
export const updateLimitsRequestSchema = z.object({
  diskGb: z.number().int().positive(),
  limits: tenantLimitsSchema,
});
export type UpdateLimitsRequest = z.infer<typeof updateLimitsRequestSchema>;

/** POST /v1/workspaces/:ws/start */
export const startWorkspaceRequestSchema = z.object({
  imageId: imageIdSchema,
  slot: slotSchema,
  limits: tenantLimitsSchema,
  env: z
    .object({
      T3CODE_GATEWAY_IDENTITY_SECRET: z.string().min(1),
      T3CODE_GATEWAY_IDENTITY_AUDIENCE: z.string().min(1),
      T3CODE_INSTANCE_NAME: z.string().min(1).optional(),
      T3CODE_VSCODE_WEB_URL: z.url().optional(),
    })
    .strict(),
});
export type StartWorkspaceRequest = z.infer<typeof startWorkspaceRequestSchema>;

export const startWorkspaceResponseSchema = z.object({
  cgroupPath: z.string().min(1),
  startedAt: z.string(),
});
export type StartWorkspaceResponse = z.infer<typeof startWorkspaceResponseSchema>;

/** One connected git host in the desired state pushed to the workspace. */
export const gitConnectionSchema = z.object({
  provider: gitProviderIdSchema,
  /** Bare hostname, validated by the web app (`normalizeGitHost`) or one of the fixed provider hosts. */
  host: z.string().min(1),
  login: z.string().min(1),
  token: z.string().min(1),
  /** Username git presents with the token over HTTPS. */
  username: z.string().min(1),
  /** known_hosts text for self-hosted hosts (pinned hosts ship their keys in the agent). */
  knownHosts: z.string().min(1).optional(),
});
export type GitConnectionSpec = z.infer<typeof gitConnectionSchema>;

/** PUT /v1/workspaces/:ws/git: the full desired git state; the agent reconciles to exactly this. */
export const putGitRequestSchema = z.object({
  connections: z.array(gitConnectionSchema).max(32),
  /** git user.name/email, set only when unset in the workspace. */
  identity: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional(),
});
export type PutGitRequest = z.infer<typeof putGitRequestSchema>;

export const putGitResponseSchema = z.object({ sshPublicKey: z.string().min(1) });
export type PutGitResponse = z.infer<typeof putGitResponseSchema>;

/** POST /v1/images/build */
export const buildImageRequestSchema = z.object({
  jobId: jobIdSchema,
  t3Ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
  /** Build number; the image is tagged with its 3-digit form (`007`). Images are always slim. */
  version: z.number().int().min(1).max(999),
});
export type BuildImageRequest = z.infer<typeof buildImageRequestSchema>;

export const scanSummarySchema = z.object({
  counts: z.object({
    CRITICAL: z.number().int().min(0),
    HIGH: z.number().int().min(0),
    MEDIUM: z.number().int().min(0),
    LOW: z.number().int().min(0),
    UNKNOWN: z.number().int().min(0),
  }),
  fixableCritical: z.number().int().min(0),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const buildImageResponseSchema = z.object({
  imageId: imageIdSchema,
  scanSummary: scanSummarySchema,
  logPath: z.string().min(1),
  /** Parsed `/opt/agentbox/versions.json` of the built image; absent for images without one. */
  manifest: imageManifestSchema.optional(),
});
export type BuildImageResponse = z.infer<typeof buildImageResponseSchema>;

/** GET /v1/images/build/:jobId/log?tail= */
export const buildLogResponseSchema = z.object({ log: z.string() });
export type BuildLogResponse = z.infer<typeof buildLogResponseSchema>;

/** GET /v1/workspaces/:ws/logs?tail= (podman logs as the tenant; 409 when the workspace is not running) */
export const MIN_DIAG_LOG_TAIL = 10;
export const MAX_DIAG_LOG_TAIL = 2000;
export const workspaceLogQuerySchema = z.object({
  tail: z.coerce.number().int().min(MIN_DIAG_LOG_TAIL).max(MAX_DIAG_LOG_TAIL).default(200),
});
export const workspaceLogResponseSchema = z.object({ log: z.string() });
export type WorkspaceLogResponse = z.infer<typeof workspaceLogResponseSchema>;

/** GET /v1/workspaces/:ws/top (podman top as the tenant; 409 when the workspace is not running) */
export const processInfoSchema = z.object({
  pid: z.number().int().nonnegative(),
  user: z.string(),
  cpu: z.number().nonnegative(),
  mem: z.number().nonnegative(),
  elapsed: z.string(),
  command: z.string(),
});
export type ProcessInfo = z.infer<typeof processInfoSchema>;
export const workspaceTopResponseSchema = z.object({
  startedAt: z.string().nullable(),
  processes: z.array(processInfoSchema),
});
export type WorkspaceTopResponse = z.infer<typeof workspaceTopResponseSchema>;

/** GET /v1/stats */
const triple = z.tuple([z.number(), z.number(), z.number()]);
const count = z.number().int().nonnegative();
export const statsResponseSchema = z.object({
  host: z.object({
    cpus: z.number().int().positive(),
    memTotalBytes: z.number().nonnegative(),
    memAvailableBytes: z.number().nonnegative(),
    diskTotalBytes: z.number().nonnegative(),
    diskFreeBytes: z.number().nonnegative(),
    loadavg: triple,
    uptimeSec: z.number().nonnegative(),
    kernel: z.string(),
    podmanVersion: z.string().nullable(),
    services: z.array(z.object({ name: z.string(), active: z.boolean() })),
    firewall: z.object({ blockedPackets: count, smtpPackets: count, ipv6Packets: count }),
    publicIpBlocked: z.string().nullable(),
  }),
  tenants: z.array(
    z.object({
      ws: wsSlugSchema,
      uid: z.number().int().positive(),
      diskUsedBytes: z.number().nonnegative(),
      diskLimitBytes: z.number().nonnegative(),
      inodesUsed: count,
      inodesLimit: count,
    }),
  ),
  workspaces: z.array(
    z.object({
      ws: wsSlugSchema,
      cpuUsageUsec: z.number().nonnegative(),
      memoryCurrent: z.number().nonnegative(),
      oomKills: z.number().int().nonnegative(),
      pidsCurrent: z.number().int().nonnegative(),
      gatewayBytesDelta: z.number().nonnegative(),
      egressBytesDelta: z.number().nonnegative(),
      running: z.boolean(),
      startedAt: z.string().nullable(),
    }),
  ),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** `host_stats.payload`: the agent stats plus the worker's own heartbeat (written every metering tick). */
export const workerHeartbeatSchema = z.object({
  heartbeatAt: z.string(),
  queue: z.object({ queued: count, running: count, failed24h: count }),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
export type HostStatsPayload = StatsResponse & { worker?: WorkerHeartbeat };

/** Generic bodies */
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;
export const errorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export { envName as envVarNameSchema };
