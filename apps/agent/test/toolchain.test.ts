import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOOLCHAIN_ERROR_CODES,
  stepRecordSchema,
  toolchainResultSchema,
  type ToolchainApplyRequest,
} from "@agentbox/core/toolchain";
import { HttpError } from "../src/errors.ts";
import type { RunOptions, RunResult } from "../src/exec.ts";

interface Call {
  user: string;
  argv: string[];
  opts: RunOptions & { detached?: boolean };
}
const calls: Call[] = [];
let respond: (call: Call) => Partial<RunResult> = () => ({});
let running = true;
let tenantRow: { ws: string; diskUsedBytes: number; diskLimitBytes: number } | null = null;

vi.mock("../src/exec.ts", async (orig) => ({
  ...(await orig<typeof import("../src/exec.ts")>()),
  runAs: vi.fn(async (user: string, argv: string[], opts: Call["opts"] = {}) => {
    const call = { user, argv, opts };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...respond(call) };
  }),
}));
vi.mock("../src/tenants.ts", async (orig) => ({
  ...(await orig<typeof import("../src/tenants.ts")>()),
  requireTenant: vi.fn(async (ws: string) => ({ ws, uid: 200007 })),
}));
vi.mock("../src/workspaces.ts", async (orig) => ({
  ...(await orig<typeof import("../src/workspaces.ts")>()),
  containerRunning: vi.fn(async () => running),
}));
vi.mock("../src/stats.ts", async (orig) => ({
  ...(await orig<typeof import("../src/stats.ts")>()),
  tenantStats: vi.fn(async () => (tenantRow ? [tenantRow] : [])),
}));

const { toolchainApply, toolchainCancel, toolchainRun, toolchainState, execArgv } =
  await import("../src/toolchain/index.ts");
const { MIN_FREE_QUOTA_BYTES, parseRunOutput, parseStateOutput, parseStepRecords, quotaDecision } =
  await import("../src/toolchain/protocol.ts");
const { routes } = await import("../src/server.ts");
const { default: applyScript } = await import("../src/toolchain/apply.sh");

const b64 = (s: string) => Buffer.from(s).toString("base64");
const GB = 1024 ** 3;

const installStep: ToolchainApplyRequest["steps"][number] = {
  tool: "bun",
  action: "install",
  version: "1.4.4",
  backends: [{ spec: "bun" }],
  bins: [
    { name: "bun", optional: false },
    { name: "bunx", optional: false },
  ],
  versionArgs: ["--version"],
};

const req: ToolchainApplyRequest = {
  runId: "run-1",
  mode: "apply",
  steps: [installStep],
};

const route = (method: string, path: string) => {
  const r = routes.find((x) => x.method === method && x.pattern.test(path));
  if (!r) throw new Error(`no route ${method} ${path}`);
  const m = r.pattern.exec(path) as RegExpExecArray;
  const params: Record<string, string> = {};
  m.slice(1).forEach((v, i) => (params[String(i)] = v));
  return (body: unknown = {}, query = "") =>
    r.handler({ params, query: new URLSearchParams(query), body: async () => body });
};

beforeEach(() => {
  calls.length = 0;
  respond = () => ({});
  running = true;
  tenantRow = { ws: "alice", diskUsedBytes: 1 * GB, diskLimitBytes: 10 * GB };
});

describe("toolchainApply", () => {
  it("writes script and plan over stdin, then starts a detached run", async () => {
    await toolchainApply("alice", req);
    const planJson = JSON.stringify(req);
    expect(calls.every((c) => c.user === "abx-alice")).toBe(true);
    for (const c of calls) {
      expect(c.argv.slice(0, 2)).toEqual(["podman", "exec"]);
      const joined = c.argv.join("\n");
      expect(joined).not.toContain(planJson);
      expect(joined).not.toContain('"steps"');
      expect(joined).not.toContain("set -uo pipefail");
      expect(joined).not.toContain("1.4.4");
    }
    const inputs = calls.filter((c) => c.opts.input !== undefined);
    expect(inputs.map((c) => c.opts.input)).toEqual([applyScript, planJson]);
    const [scriptWrite, planWrite] = inputs as [Call, Call];
    expect(scriptWrite.argv).toEqual([
      "podman",
      "exec",
      "-i",
      "-u",
      "1000",
      "--workdir",
      "/workspace/home",
      "abx-ws",
      "sh",
      "-c",
      'umask 077; cat > "$1" && chmod 600 "$1"',
      "sh",
      "/workspace/home/.agentbox/runs/run-1/apply.sh",
    ]);
    expect(planWrite.argv.at(-1)).toBe("/workspace/home/.agentbox/runs/run-1/plan.json");

    const start = calls.at(-1) as Call;
    expect(start.opts.detached).toBe(true);
    expect(start.argv).toEqual([
      "podman",
      "exec",
      "-d",
      "-u",
      "1000",
      "--workdir",
      "/workspace/home",
      "abx-ws",
      "bash",
      "-c",
      'exec setsid bash "$1" "$2" >"$3" 2>&1 </dev/null',
      "abx",
      "/workspace/home/.agentbox/runs/run-1/apply.sh",
      "/workspace/home/.agentbox/runs/run-1",
      "/workspace/home/.agentbox/logs/run-1.log",
    ]);
  });

  it("409 when the workspace is not running", async () => {
    running = false;
    await expect(toolchainApply("alice", req)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  it("422 when the image has no mise", async () => {
    respond = (c) => (c.argv.join(" ").includes("command -v mise") ? { code: 1 } : {});
    const err = await toolchainApply("alice", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, message: "image has no mise" });
    expect(calls.some((c) => c.opts.input !== undefined)).toBe(false);
  });

  it("507 with a plain quota message when little quota is left", async () => {
    tenantRow = { ws: "alice", diskUsedBytes: 9.5 * GB, diskLimitBytes: 10 * GB };
    const err = (await toolchainApply("alice", req).catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(507);
    expect(err.message).toMatch(/^quota: /);
    expect(calls.some((c) => c.opts.input !== undefined)).toBe(false);
  });

  it("423 naming the active run when a run holds the lock, 500 on other lock failures", async () => {
    respond = (c) => (c.argv.join(" ").includes("run.lock") ? { code: 1, stdout: "run-0\n" } : {});
    await expect(toolchainApply("alice", req)).rejects.toMatchObject({
      status: 423,
      message: "toolchain run run-0 is active",
    });
    respond = (c) =>
      c.argv.join(" ").includes("run.lock") ? { code: 127, stderr: "no flock" } : {};
    await expect(toolchainApply("alice", req)).rejects.toMatchObject({ status: 500 });
    expect(calls.some((c) => c.opts.input !== undefined)).toBe(false);
  });

  it("skips the quota check for check runs and runs without installs", async () => {
    tenantRow = { ws: "alice", diskUsedBytes: 10 * GB, diskLimitBytes: 10 * GB };
    await toolchainApply("alice", { runId: "chk", mode: "check", steps: [] });
    await toolchainApply("alice", {
      runId: "rm",
      mode: "apply",
      steps: [{ ...installStep, action: "remove", version: null, backends: [] }],
    });
    expect(calls.filter((c) => c.opts.detached)).toHaveLength(2);
  });

  it("rejects run ids that look like options", async () => {
    await expect(toolchainApply("alice", { ...req, runId: "-rf" })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("quotaDecision", () => {
  const apply = { mode: "apply" as const, steps: [installStep] };
  it("rejects below 700 MB remaining", () => {
    const used = 10 * GB - (MIN_FREE_QUOTA_BYTES - 1);
    expect(quotaDecision({ diskUsedBytes: used, diskLimitBytes: 10 * GB }, apply)).toMatch(/quota/);
  });
  it("accepts at exactly 700 MB, with no quota, and for unknown tenants", () => {
    const used = 10 * GB - MIN_FREE_QUOTA_BYTES;
    expect(quotaDecision({ diskUsedBytes: used, diskLimitBytes: 10 * GB }, apply)).toBeNull();
    expect(quotaDecision({ diskUsedBytes: 5 * GB, diskLimitBytes: 0 }, apply)).toBeNull();
    expect(quotaDecision(undefined, apply)).toBeNull();
  });
  it("ignores plans without an install step", () => {
    const full = { diskUsedBytes: 10 * GB, diskLimitBytes: 10 * GB };
    expect(quotaDecision(full, { mode: "apply", steps: [] })).toBeNull();
    expect(quotaDecision(full, { mode: "check", steps: [installStep] })).toBeNull();
  });
});

const stepsJsonl = [
  { tool: "bun", action: "install", status: "running", version: "1.4.4" },
  {
    tool: "bun",
    action: "install",
    status: "ok",
    version: "1.4.4",
    previous: "1.3.0",
    backend: "bun",
    sizeBytes: 104906752,
    observed: "1.4.4",
    durationMs: 1500,
  },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

const resultJson = JSON.stringify({
  exitCode: 0,
  finishedAt: "2026-10-30T04:32:24Z",
  steps: [JSON.parse(stepsJsonl.split("\n")[1] as string)],
  tools: {
    bun: {
      version: "1.4.4",
      previous: "1.3.0",
      backend: "bun",
      bins: ["bun", "bunx"],
      sizeBytes: 104906752,
      installedAt: "2026-10-30T04:32:24Z",
      observed: "1.4.4",
    },
  },
});

const runOut = (state: string, log: string, steps = "", result = "") =>
  `${state}\n${b64(log)}\n${b64(steps)}\n${b64(result)}\n`;

describe("parseRunOutput", () => {
  it("running: partial log line is held back, steps parsed", () => {
    const r = parseRunOutput(runOut("running", "line one\nline tw", stepsJsonl.split("\n")[0]), 10);
    expect(r.state).toBe("running");
    expect(r.log).toBe("line one\n");
    expect(r.nextOffset).toBe(10 + Buffer.byteLength("line one\n"));
    expect(r.steps).toHaveLength(1);
    expect(r.result).toBeNull();
  });
  it("finished: full log and a result that matches the core schema", () => {
    const r = parseRunOutput(runOut("finished", "done\nno newline", stepsJsonl, resultJson), 0);
    expect(r.state).toBe("finished");
    expect(r.log).toBe("done\nno newline");
    expect(r.nextOffset).toBe(Buffer.byteLength("done\nno newline"));
    expect(toolchainResultSchema.parse(r.result).tools["bun"]?.previous).toBe("1.3.0");
    expect(r.steps.map((s) => s.status)).toEqual(["running", "ok"]);
  });
  it("interrupted: no result and the script is gone", () => {
    const r = parseRunOutput(runOut("interrupted", "partial\n", stepsJsonl.split("\n")[0]), 0);
    expect(r.state).toBe("interrupted");
    expect(r.result).toBeNull();
  });
  it("finished with an unreadable result.json counts as interrupted", () => {
    expect(parseRunOutput(runOut("finished", "", "", "{not json"), 0).state).toBe("interrupted");
  });
  it("missing: run dir does not exist, offset is kept", () => {
    expect(parseRunOutput("missing\n", 42)).toEqual({
      state: "missing",
      log: "",
      nextOffset: 42,
      steps: [],
      result: null,
    });
  });
  it("counts bytes, not characters, for multi-byte text", () => {
    const r = parseRunOutput(runOut("finished", "ok ✓\n"), 5);
    expect(r.nextOffset).toBe(5 + Buffer.byteLength("ok ✓\n"));
  });
  it("rejects garbage", () => {
    expect(() => parseRunOutput("weird\n", 0)).toThrow(HttpError);
  });
});

describe("parseStepRecords", () => {
  it("accepts script output and skips broken lines", () => {
    const records = parseStepRecords(`${stepsJsonl}\nnot json\n{"tool":"nope"}\n\n`);
    expect(records).toHaveLength(2);
    for (const r of records) expect(stepRecordSchema.safeParse(r).success).toBe(true);
  });
  it("keeps verify and failure fields", () => {
    const [v, f] = parseStepRecords(
      [
        '{"tool":"node","action":"verify","status":"ok","observed":"v26.13.0","path":"/workspace/home/.agentbox/bin/node","durationMs":12}',
        '{"tool":"bun","action":"install","status":"failed","errorCode":"version_not_found","error":"x","durationMs":3}',
      ].join("\n"),
    );
    expect(v).toMatchObject({ observed: "v26.13.0", path: "/workspace/home/.agentbox/bin/node" });
    expect(f).toMatchObject({ errorCode: "version_not_found" });
  });
});

describe("parseStateOutput", () => {
  const tool = {
    version: "1.4.4",
    previous: null,
    backend: "bun",
    bins: ["bun"],
    sizeBytes: 1,
    installedAt: "2026-10-30T04:32:24Z",
    observed: null,
  };
  it("combines toolchain.json, versions.json and mise presence", () => {
    const out = [
      b64(JSON.stringify({ tools: { bun: tool, bad: { version: 1 } } })),
      b64(JSON.stringify({ mise: "2026.10.23", toolchainAbi: "ubuntu-26.04", envVersion: 1 })),
      "1",
    ].join("\n");
    expect(parseStateOutput(`${out}\n`)).toEqual({
      tools: { bun: tool },
      image: { hasMise: true, toolchainAbi: "ubuntu-26.04", envVersion: 1 },
    });
  });
  it("tolerates a fresh workspace and an old image", () => {
    expect(parseStateOutput("\n\n0\n")).toEqual({
      tools: {},
      image: { hasMise: false, toolchainAbi: null, envVersion: null },
    });
  });
});

describe("run, state and cancel exec calls", () => {
  it("run passes run id and offset as positional args", async () => {
    respond = () => ({ stdout: runOut("running", "x\n") });
    const r = await toolchainRun("alice", "run-1", 7);
    expect(r.log).toBe("x\n");
    const argv = (calls.at(-1) as Call).argv;
    expect(argv.slice(-2)).toEqual(["run-1", "7"]);
    expect(argv.slice(0, 8)).toEqual(execArgv([]).slice(0, 8));
  });
  it("state and cancel require a running workspace", async () => {
    running = false;
    await expect(toolchainState("alice")).rejects.toMatchObject({ status: 409 });
    await expect(toolchainCancel("alice", "run-1")).rejects.toMatchObject({ status: 409 });
  });
  it("cancel targets the run's pid file only", async () => {
    respond = () => ({ stdout: "stopped\n" });
    await toolchainCancel("alice", "run-1");
    const argv = (calls.at(-1) as Call).argv;
    expect(argv.at(-1)).toBe("run-1");
    expect(argv.join(" ")).toContain("kill -TERM");
  });
});

describe("routes", () => {
  const apply = () => route("POST", "/v1/workspaces/alice/toolchain/apply");

  it("registers the four toolchain routes", () => {
    expect(route("POST", "/v1/workspaces/alice/toolchain/apply")).toBeTypeOf("function");
    expect(route("GET", "/v1/workspaces/alice/toolchain/runs/r1")).toBeTypeOf("function");
    expect(route("GET", "/v1/workspaces/alice/toolchain/state")).toBeTypeOf("function");
    expect(route("POST", "/v1/workspaces/alice/toolchain/runs/r1/cancel")).toBeTypeOf("function");
  });
  it("apply: 400 for a bad run id, version and unknown backend", async () => {
    await expect(apply()({ ...req, runId: "../x" })).rejects.toMatchObject({ status: 400 });
    await expect(
      apply()({ ...req, steps: [{ ...installStep, version: "1; rm -rf /" }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      apply()({ ...req, steps: [{ ...installStep, backends: [{ spec: "evil;cmd" }] }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      apply()({
        ...req,
        steps: [{ ...installStep, backends: [{ spec: "bun", options: { run: "x" } }] }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
  it("apply: a valid body reaches the exec layer", async () => {
    await expect(apply()(req)).resolves.toEqual({ ok: true });
    expect(calls.length).toBeGreaterThan(0);
  });
  it("run and cancel: 400 for a bad run id or offset", async () => {
    await expect(route("GET", "/v1/workspaces/alice/toolchain/runs/-x")()).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      route("GET", "/v1/workspaces/alice/toolchain/runs/r1")({}, "offset=-1"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route("POST", "/v1/workspaces/alice/toolchain/runs/bad%20id/cancel")(),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects a bad workspace slug", async () => {
    await expect(route("GET", "/v1/workspaces/Bad_Slug/toolchain/state")()).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("apply.sh", () => {
  it("is strict bash and emits every error code the contract defines", () => {
    expect(applyScript.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(applyScript).toContain("set -uo pipefail");
    for (const code of TOOLCHAIN_ERROR_CODES) expect(applyScript, code).toContain(code);
  });
});
