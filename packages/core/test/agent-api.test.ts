import { describe, expect, it } from "vitest";
import {
  buildImageRequestSchema,
  buildImageResponseSchema,
  createTenantRequestSchema,
  errorResponseSchema,
  githubConnectRequestSchema,
  imageParamsSchema,
  jobParamsSchema,
  logQuerySchema,
  startWorkspaceRequestSchema,
  startWorkspaceResponseSchema,
  statsResponseSchema,
  updateLimitsRequestSchema,
  wsParamsSchema,
  workspaceLogQuerySchema,
} from "../src/agent-api.ts";

const limits = { cpus: 2, memoryMb: 4096, pidsLimit: 2048 };
const img = "a".repeat(64);

describe("agent-api request schemas", () => {
  const rows: [string, { safeParse: (v: unknown) => { success: boolean } }, unknown, boolean][] = [
    ["tenant ok", createTenantRequestSchema, { ws: "alice", slot: 1, diskGb: 10, limits }, true],
    [
      "tenant bad ws",
      createTenantRequestSchema,
      { ws: "../x", slot: 1, diskGb: 10, limits },
      false,
    ],
    [
      "tenant slot 5000",
      createTenantRequestSchema,
      { ws: "alice", slot: 5000, diskGb: 10, limits },
      false,
    ],
    [
      "tenant diskGb 0",
      createTenantRequestSchema,
      { ws: "alice", slot: 1, diskGb: 0, limits },
      false,
    ],
    ["limits ok", updateLimitsRequestSchema, { diskGb: 10, limits }, true],
    ["limits missing", updateLimitsRequestSchema, { diskGb: 10 }, false],
    [
      "start ok",
      startWorkspaceRequestSchema,
      {
        imageId: img,
        slot: 3,
        limits,
        env: { T3CODE_GATEWAY_IDENTITY_SECRET: "s", T3CODE_GATEWAY_IDENTITY_AUDIENCE: "alice" },
      },
      true,
    ],
    [
      "start bad image",
      startWorkspaceRequestSchema,
      {
        imageId: "../etc",
        slot: 3,
        limits,
        env: { T3CODE_GATEWAY_IDENTITY_SECRET: "s", T3CODE_GATEWAY_IDENTITY_AUDIENCE: "a" },
      },
      false,
    ],
    [
      "start extra env rejected",
      startWorkspaceRequestSchema,
      {
        imageId: img,
        slot: 3,
        limits,
        env: {
          T3CODE_GATEWAY_IDENTITY_SECRET: "s",
          T3CODE_GATEWAY_IDENTITY_AUDIENCE: "a",
          LD_PRELOAD: "x",
        },
      },
      false,
    ],
    ["github ok", githubConnectRequestSchema, { token: "t", login: "l", email: "e@x.y" }, true],
    ["github missing token", githubConnectRequestSchema, { login: "l", email: "e" }, false],
    ["build ok", buildImageRequestSchema, { jobId: "job-1", t3Ref: "omp-overlay" }, true],
    [
      "build ref with option injection",
      buildImageRequestSchema,
      { jobId: "job-1", t3Ref: "--evil" },
      false,
    ],
    ["build bad jobId", buildImageRequestSchema, { jobId: "../x", t3Ref: "main" }, false],
    ["ws param ok", wsParamsSchema, { ws: "alice" }, true],
    ["ws param bad", wsParamsSchema, { ws: "Alice" }, false],
    ["image param ok", imageParamsSchema, { imageId: img }, true],
    ["image param short", imageParamsSchema, { imageId: "abc" }, false],
    ["job param ok", jobParamsSchema, { jobId: "abc123" }, true],
    ["job param bad", jobParamsSchema, { jobId: "a/b" }, false],
  ];
  it.each(rows)("%s", (_n, schema, value, ok) => expect(schema.safeParse(value).success).toBe(ok));

  it("log query defaults and coerces", () => {
    expect(logQuerySchema.parse({})).toEqual({ tail: 200 });
    expect(logQuerySchema.parse({ tail: "50" })).toEqual({ tail: 50 });
    expect(logQuerySchema.safeParse({ tail: "-1" }).success).toBe(false);
  });
});

describe("agent-api response schemas", () => {
  it("stats", () => {
    const v = {
      host: {
        cpus: 16,
        memTotalBytes: 1,
        memAvailableBytes: 1,
        diskTotalBytes: 1,
        diskFreeBytes: 1,
        loadavg: [0.1, 0.2, 0.3],
        uptimeSec: 100,
        kernel: "7.0.0-38-generic",
        podmanVersion: "5.7.0",
        services: [{ name: "agentbox-agent", active: true }],
        firewall: { blockedPackets: 1, smtpPackets: 2, ipv6Packets: 3 },
        publicIpBlocked: null,
      },
      tenants: [
        {
          ws: "alice",
          uid: 200001,
          diskUsedBytes: 1,
          diskLimitBytes: 2,
          inodesUsed: 3,
          inodesLimit: 4,
        },
      ],
      workspaces: [
        {
          ws: "alice",
          cpuUsageUsec: 5,
          memoryCurrent: 6,
          oomKills: 0,
          pidsCurrent: 3,
          gatewayBytesDelta: 0,
          egressBytesDelta: 0,
          running: true,
          startedAt: "2026-03-10T12:00:00.000Z",
        },
      ],
    };
    expect(statsResponseSchema.parse(v)).toEqual(v);
    expect(
      statsResponseSchema.safeParse({ ...v, host: { ...v.host, loadavg: [1, 2] } }).success,
    ).toBe(false);
  });
  it("build response", () => {
    const v = {
      imageId: img,
      scanSummary: {
        counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 0 },
        fixableCritical: 0,
      },
      logPath: "/var/lib/agentbox-build/logs/j.log",
    };
    expect(buildImageResponseSchema.parse(v)).toEqual(v);
    expect(
      buildImageResponseSchema.safeParse({ ...v, scanSummary: { counts: {}, fixableCritical: 0 } })
        .success,
    ).toBe(false);
  });
  it("start response and error body", () => {
    const v = { cgroupPath: "user.slice/x", startedAt: "2026-01-01T00:00:00.000Z" };
    expect(startWorkspaceResponseSchema.parse(v)).toEqual(v);
    expect(errorResponseSchema.parse({ error: "boom" })).toEqual({ error: "boom" });
    expect(errorResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("diagnostic schemas", () => {
  it("log tail is bounded to 10..2000 and defaults to 200", () => {
    expect(workspaceLogQuerySchema.parse({})).toEqual({ tail: 200 });
    expect(workspaceLogQuerySchema.safeParse({ tail: "9" }).success).toBe(false);
    expect(workspaceLogQuerySchema.safeParse({ tail: "2001" }).success).toBe(false);
    expect(workspaceLogQuerySchema.parse({ tail: "2000" })).toEqual({ tail: 2000 });
  });
});
