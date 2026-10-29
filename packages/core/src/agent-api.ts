import { z } from "zod";

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
    })
    .strict(),
});
export type StartWorkspaceRequest = z.infer<typeof startWorkspaceRequestSchema>;

export const startWorkspaceResponseSchema = z.object({
  cgroupPath: z.string().min(1),
  startedAt: z.string(),
});
export type StartWorkspaceResponse = z.infer<typeof startWorkspaceResponseSchema>;

/** POST /v1/workspaces/:ws/github */
export const githubConnectRequestSchema = z.object({
  token: z.string().min(1),
  login: z.string().min(1),
  email: z.string().min(1),
});
export type GithubConnectRequest = z.infer<typeof githubConnectRequestSchema>;

/** POST /v1/images/build */
export const buildImageRequestSchema = z.object({
  jobId: jobIdSchema,
  t3Ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
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
