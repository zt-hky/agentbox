import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tstz("created_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

export const tenantSlotSeq = pgSequence("tenant_slot_seq", {
  startWith: 1,
  minValue: 1,
  maxValue: 4999,
  increment: 1,
  cycle: false,
});

/* ---------------- better-auth (drizzle pg adapter + admin plugin) ---------------- */

export const ACCESS_STATUSES = ["none", "pending", "active", "rejected", "suspended"] as const;

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  // admin plugin
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: tstz("ban_expires"),
  // agentbox
  accessStatus: text("access_status", { enum: ACCESS_STATUSES }).notNull().default("none"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: tstz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // admin plugin
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tstz("access_token_expires_at"),
    refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/* ---------------- agentbox ---------------- */

const userRef = (name = "user_id") =>
  text(name)
    .notNull()
    .references(() => user.id);

export const accessRequests = pgTable(
  "access_requests",
  {
    id: id(),
    userId: userRef(),
    message: text("message"),
    requestedSlug: text("requested_slug"),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: tstz("decided_at"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("access_requests_pending_slug_uq")
      .on(t.requestedSlug)
      .where(sql`${t.status} = 'pending' and ${t.requestedSlug} is not null`),
  ],
);

export const plans = pgTable("plans", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["free", "package", "payg"] }).notNull(),
  monthlyPriceMicro: bigint("monthly_price_micro", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  cpuLimit: numeric("cpu_limit", { precision: 5, scale: 2 }).notNull(),
  memoryLimitMb: integer("memory_limit_mb").notNull(),
  diskLimitGb: integer("disk_limit_gb").notNull(),
  pidsLimit: integer("pids_limit").notNull().default(2048),
  allowanceRuntimeHours: doublePrecision("allowance_runtime_hours").notNull().default(0),
  allowanceCpuCoreHours: doublePrecision("allowance_cpu_core_hours").notNull().default(0),
  allowanceMemGbHours: doublePrecision("allowance_mem_gb_hours").notNull().default(0),
  /** XFS inode hard limit. */
  inodesLimit: integer("inodes_limit").notNull().default(4000000),
  /** Free trial length in days; null = no trial. */
  trialDays: integer("trial_days"),
  /** Daily runtime cap (hours per local day); null = none. */
  dailyRuntimeHours: doublePrecision("daily_runtime_hours"),
  /** Per-plan override of hibernation.maxAwakeHours; null = global. */
  maxAwakeHours: doublePrecision("max_awake_hours"),
  /** Per-plan override of hibernation.idleTimeoutMinutes; null = global. */
  idleTimeoutMinutes: integer("idle_timeout_minutes"),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Shown to users / landing; false = internal (assigned by admins only). */
  public: boolean("public").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const prices = pgTable("prices", {
  id: id(),
  runtimePerHour: bigint("runtime_per_hour", { mode: "bigint" }).notNull(),
  cpuCorePerHour: bigint("cpu_core_per_hour", { mode: "bigint" }).notNull(),
  memGbPerHour: bigint("mem_gb_per_hour", { mode: "bigint" }).notNull(),
  effectiveFrom: tstz("effective_from").notNull().defaultNow(),
  createdAt: createdAt(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: createdAt(),
});

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  userId: userRef().unique(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  cycleStart: tstz("cycle_start").notNull(),
  cycleEnd: tstz("cycle_end").notNull(),
  usedRuntimeHours: doublePrecision("used_runtime_hours").notNull().default(0),
  usedCpuCoreHours: doublePrecision("used_cpu_core_hours").notNull().default(0),
  usedMemGbHours: doublePrecision("used_mem_gb_hours").notNull().default(0),
  trialEndsAt: tstz("trial_ends_at"),
  /** Local (Asia/Ho_Chi_Minh) date that `usedTodayRuntimeHours` counts for. */
  dayStart: date("day_start", { mode: "string" }),
  usedTodayRuntimeHours: doublePrecision("used_today_runtime_hours").notNull().default(0),
  createdAt: createdAt(),
});

export const creditBalances = pgTable("credit_balances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id),
  balanceMicro: bigint("balance_micro", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  createdAt: createdAt(),
});

export const LEDGER_REASONS = [
  "admin_topup",
  "adjustment",
  "usage",
  "package_fee",
  "free_grant",
] as const;

export const WORKSPACE_STATUSES = [
  "provisioning",
  "sleeping",
  "starting",
  "running",
  "stopping",
  "error",
  "deleting",
  "deleted",
] as const;

export const workspaces = pgTable("workspaces", {
  id: id(),
  userId: userRef().unique(),
  slug: text("slug").notNull().unique(),
  slot: integer("slot").notNull().unique(),
  status: text("status", { enum: WORKSPACE_STATUSES }).notNull().default("provisioning"),
  // Podman image id this workspace's container last started with (authoritative once started).
  imageId: text("image_id"),
  // Admin pin: start from this image instead of the active one. Null = follow the active image.
  pinnedImageId: uuid("pinned_image_id").references(() => images.id),
  identitySecretEnc: text("identity_secret_enc").notNull(),
  lastRequestAt: tstz("last_request_at"),
  lastActivityAt: tstz("last_activity_at"),
  awakeSince: tstz("awake_since"),
  lastCpuUsec: bigint("last_cpu_usec", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  startFailures: integer("start_failures").notNull().default(0),
  githubSyncPending: boolean("github_sync_pending").notNull().default(false),
  createdAt: createdAt(),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    userId: userRef(),
    deltaMicro: bigint("delta_micro", { mode: "bigint" }).notNull(),
    reason: text("reason", { enum: LEDGER_REASONS }).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    note: text("note"),
    actorId: text("actor_id").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_user_created_idx").on(t.userId, t.createdAt)],
);

export const images = pgTable("images", {
  id: id(),
  // Null while building: the Podman image ID and rootfs path exist only after the build.
  imageId: text("image_id").unique(),
  rootfsPath: text("rootfs_path"),
  t3Ref: text("t3_ref").notNull(),
  status: text("status", { enum: ["building", "ready", "failed", "active", "retired"] })
    .notNull()
    .default("building"),
  buildLog: text("build_log"),
  scanSummary: jsonb("scan_summary"),
  overrideReason: text("override_reason"),
  createdBy: text("created_by").references(() => user.id),
  createdAt: createdAt(),
});

export const usageSamples = pgTable(
  "usage_samples",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ts: tstz("ts").notNull(),
    runtimeSec: doublePrecision("runtime_sec").notNull(),
    cpuCoreSec: doublePrecision("cpu_core_sec").notNull(),
    memGbSec: doublePrecision("mem_gb_sec").notNull(),
    chargeMicro: bigint("charge_micro", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [index("usage_samples_ws_ts_idx").on(t.workspaceId, t.ts)],
);

export const workspaceSessions = pgTable("workspace_sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: userRef(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  host: text("host").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  revokedAt: tstz("revoked_at"),
  createdAt: createdAt(),
});

export const handoffCodes = pgTable("handoff_codes", {
  id: id(),
  codeHash: text("code_hash").notNull().unique(),
  userId: userRef(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  host: text("host").notNull(),
  returnPath: text("return_path").notNull().default("/"),
  expiresAt: tstz("expires_at").notNull(),
  usedAt: tstz("used_at"),
  createdAt: createdAt(),
});

export const githubConnections = pgTable("github_connections", {
  id: id(),
  userId: userRef().unique(),
  login: text("login").notNull(),
  githubId: bigint("github_id", { mode: "bigint" }).notNull(),
  tokenEnc: text("token_enc").notNull(),
  scopes: text("scopes"),
  createdAt: createdAt(),
});

export const JOB_TYPES = [
  "provision_tenant",
  "start_workspace",
  "stop_workspace",
  "delete_tenant",
  "sync_github",
  "update_limits",
  "build_image",
  "delete_image",
  "restart_workspace",
  "fetch_logs",
  "inspect_workspace",
] as const;

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type", { enum: JOB_TYPES }).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    payload: jsonb("payload"),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    result: jsonb("result"),
    finishedAt: tstz("finished_at"),
    runAfter: tstz("run_after").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("jobs_active_ws_type_uq")
      .on(t.workspaceId, t.type)
      .where(sql`${t.status} in ('queued','running')`),
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
  ],
);

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type", {
      enum: [
        "started",
        "stopped",
        "crashed",
        "oom",
        "policy_violation",
        "start_failed",
        "credits_exhausted",
        "max_awake",
        "daily_limit",
        "trial_ended",
      ],
    }).notNull(),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("workspace_events_ws_created_idx").on(t.workspaceId, t.createdAt)],
);

export const hostStats = pgTable(
  "host_stats",
  {
    id: integer("id").primaryKey().default(1),
    payload: jsonb("payload").notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [check("host_stats_singleton", sql`${t.id} = 1`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);
