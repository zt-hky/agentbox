import { describe, expect, it } from "vitest";
import {
  CATALOG,
  agentStepSchema,
  abiIsOlder,
  buildPlan,
  compareVersions,
  evaluateImageGate,
  fetchLatestInfo,
  imageManifestSchema,
  isManaged,
  manifestFromVersions,
  parseMuseManifest,
  parseNodeIndex,
  parseNpmPackument,
  parsePythonList,
  parseVersionOutput,
  requireEntry,
  resolveTarget,
  selectableLines,
  selectablePins,
  toAgentStep,
  toolchainApplyRequestSchema,
  updateAvailable,
  versionLines,
  type DesiredRow,
  type FetchLike,
  type LatestInfo,
  type ObservedRow,
  type ToolId,
} from "../src/toolchain/index.ts";
import { parseSetting } from "../src/settings.ts";

const nodeIndex = [
  { version: "v27.0.0-alpha.0.0.0", lts: false },
  { version: "v26.13.0", lts: "Krypton" },
  { version: "v25.9.0", lts: false },
  { version: "v24.22.2", lts: "Krypton" },
  { version: "v22.14.1", lts: "Jod" },
  { version: "v22.14.0", lts: "Jod" },
  { version: "v22.13.1", lts: "Jod" },
];
const pythonList = [
  "3.16-dev",
  "3.16.0a1",
  "3.14.10",
  "3.14.9",
  "3.13.12",
  "3.12.16",
  "3.12.9",
  "3.12.10",
  "3.12.0",
  "activepython-3.5.4",
].join("\n");

const info = {
  node: parseNodeIndex(nodeIndex),
  python: parsePythonList(pythonList),
  bun: { latest: "1.4.4", lts: null, versions: ["1.4.4", "1.4.3", "1.4.2"] },
  claude: { latest: "2.1.314", lts: null, versions: ["2.1.314", "2.1.312"] },
} as Partial<Record<ToolId, LatestInfo>>;

describe("versions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("3.12.10", "3.12.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4.14-R7309.1", "1.4.14-R7309")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("parses version output", () => {
    expect(parseVersionOutput("2.1.314 (Claude Code)")).toBe("2.1.314");
    expect(parseVersionOutput("v24.22.2")).toBe("24.22.2");
    expect(parseVersionOutput("muse 1.4.14-R7309.1")).toBe("1.4.14-R7309.1");
    expect(parseVersionOutput("no version")).toBeNull();
  });

  it("node: latest is newest stable, lts is newest LTS", () => {
    expect(info.node?.latest).toBe("26.13.0");
    expect(info.node?.lts).toBe("26.13.0");
    expect(info.node?.versions).not.toContain("27.0.0-alpha.0.0.0");
  });

  it("python: skips pre-releases and non-CPython names", () => {
    expect(info.python?.latest).toBe("3.14.10");
    expect(info.python?.versions).toEqual([
      "3.14.10",
      "3.14.9",
      "3.13.12",
      "3.12.16",
      "3.12.10",
      "3.12.9",
      "3.12.0",
    ]);
  });

  it("lists recent lines newest first with their newest patch", () => {
    expect(versionLines(info.python?.versions ?? [], 8)).toEqual([
      { line: "3.14", latest: "3.14.10" },
      { line: "3.13", latest: "3.13.12" },
      { line: "3.12", latest: "3.12.16" },
    ]);
    expect(selectableLines(requireEntry("bun"), ["1.4.4"])).toEqual([]);
    expect(selectablePins(requireEntry("python"), ["3.12.1"])).toEqual([]);
    expect(selectablePins(requireEntry("bun"), ["1.4.2", "1.4.4", "1.4.3"])).toEqual([
      "1.4.4",
      "1.4.3",
      "1.4.2",
    ]);
  });

  it("npm: follows a stable dist-tag, ignores pre-releases", () => {
    const r = parseNpmPackument({
      "dist-tags": { latest: "1.0.105", prerelease: "1.0.105-1" },
      versions: { "1.0.102": {}, "1.0.105-1": {}, "1.0.105": {} },
    });
    expect(r).toEqual({ latest: "1.0.105", lts: null, versions: ["1.0.105", "1.0.102"] });
    const lagging = parseNpmPackument({
      "dist-tags": { latest: "1.0.0-beta" },
      versions: { "0.9.0": {}, "1.0.0-beta": {} },
    });
    expect(lagging.latest).toBe("0.9.0");
  });

  it("muse: takes the Linux x64 artifact with a sha256 checksum", () => {
    const r = parseMuseManifest({
      version: "1.4.14-R7309.1",
      artifacts: {
        x86_linux: { url: "https://example.com/muse", checksum: "a".repeat(64) },
        x86_macos: { url: "https://example.com/mac", checksum: "b".repeat(64) },
      },
    });
    expect(r.latest).toBe("1.4.14-R7309.1");
    expect(r.meta).toEqual({
      url: "https://example.com/muse",
      checksum: `sha256:${"a".repeat(64)}`,
    });
    expect(() => parseMuseManifest({ version: "1", artifacts: {} })).toThrow();
  });
});

describe("resolveTarget", () => {
  const node = requireEntry("node");
  const python = requireEntry("python");
  const bun = requireEntry("bun");

  it("latest and lts channels", () => {
    expect(resolveTarget(node, "lts", null, info.node)).toEqual({ ok: true, version: "26.13.0" });
    expect(resolveTarget(bun, "latest", null, info.bun)).toEqual({ ok: true, version: "1.4.4" });
    expect(resolveTarget(bun, "lts", null, info.bun)).toMatchObject({ ok: false });
  });

  it("a python line resolves to the newest patch in that line", () => {
    expect(resolveTarget(python, "pin", "3.12", info.python)).toEqual({
      ok: true,
      version: "3.12.16",
    });
    expect(resolveTarget(python, "pin", "3.13", info.python)).toEqual({
      ok: true,
      version: "3.13.12",
    });
  });

  it("a node minor line resolves to the newest patch of that minor", () => {
    expect(resolveTarget(node, "pin", "22.14", info.node)).toEqual({
      ok: true,
      version: "22.14.1",
    });
    expect(resolveTarget(node, "pin", "22", info.node)).toEqual({ ok: true, version: "22.14.1" });
  });

  it("a line with no release is an error, not a guess", () => {
    expect(resolveTarget(python, "pin", "3.8", info.python)).toMatchObject({ ok: false });
    expect(resolveTarget(node, "pin", null, info.node)).toMatchObject({ ok: false });
  });

  it("exact pins for tools without lines must be published versions", () => {
    expect(resolveTarget(bun, "pin", "1.4.3", info.bun)).toEqual({ ok: true, version: "1.4.3" });
    expect(resolveTarget(bun, "pin", "1.3.0", info.bun)).toMatchObject({ ok: false });
  });

  it("unknown versions are an error", () => {
    expect(resolveTarget(node, "latest", null, undefined)).toMatchObject({ ok: false });
  });
});

const want = (
  toolId: string,
  channel: DesiredRow["channel"] = "latest",
  pinnedVersion: string | null = null,
  desired = true,
): DesiredRow => ({
  toolId,
  channel,
  pinnedVersion,
  desired,
});
const have = (
  toolId: string,
  installedVersion: string | null,
  extra: Partial<ObservedRow> = {},
): ObservedRow => ({
  toolId,
  state: installedVersion ? "idle" : "pending",
  installedVersion,
  previousVersion: null,
  backend: installedVersion ? "aqua:x/y" : null,
  ...extra,
});

describe("buildPlan", () => {
  it("installs missing tools, runtimes first, with exact resolved versions", () => {
    const plan = buildPlan({
      desired: [want("claude"), want("python", "pin", "3.12"), want("node", "lts"), want("bun")],
      observed: [],
      latest: info,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.steps).toEqual([
      { tool: "node", action: "install", from: null, to: "26.13.0" },
      { tool: "bun", action: "install", from: null, to: "1.4.4" },
      { tool: "python", action: "install", from: null, to: "3.12.16" },
      { tool: "claude", action: "install", from: null, to: "2.1.314" },
    ]);
  });

  it("replaces an image-provided tool (external) with a managed copy", () => {
    const plan = buildPlan({
      desired: [want("claude")],
      observed: [have("claude", "2.1.100", { state: "external", backend: null })],
      latest: info,
    });
    expect(plan.steps).toEqual([
      { tool: "claude", action: "install", from: "2.1.100", to: "2.1.314" },
    ]);
  });

  it("does not upgrade on its own, only on request", () => {
    const observed = [have("claude", "2.1.312")];
    expect(buildPlan({ desired: [want("claude")], observed, latest: info }).steps).toEqual([]);
    expect(
      buildPlan({ desired: [want("claude")], observed, latest: info, upgrade: ["claude"] }).steps,
    ).toEqual([{ tool: "claude", action: "upgrade", from: "2.1.312", to: "2.1.314" }]);
    expect(
      buildPlan({ desired: [want("claude")], observed, latest: info, upgrade: "all" }).steps,
    ).toHaveLength(1);
    expect(
      buildPlan({
        desired: [want("claude")],
        observed: [have("claude", "2.1.314")],
        latest: info,
        upgrade: "all",
      }).steps,
    ).toEqual([]);
  });

  it("applies a pin change without being asked and labels downgrades", () => {
    const plan = buildPlan({
      desired: [want("python", "pin", "3.12"), want("bun", "pin", "1.4.2")],
      observed: [have("python", "3.14.10"), have("bun", "1.4.4")],
      latest: info,
    });
    expect(plan.steps).toEqual([
      { tool: "bun", action: "downgrade", from: "1.4.4", to: "1.4.2" },
      { tool: "python", action: "downgrade", from: "3.14.10", to: "3.12.16" },
    ]);
  });

  it("a line pin is satisfied by an older patch until an upgrade is requested", () => {
    const observed = [have("python", "3.12.10")];
    const desired = [want("python", "pin", "3.12")];
    expect(buildPlan({ desired, observed, latest: info }).steps).toEqual([]);
    expect(buildPlan({ desired, observed, latest: info, upgrade: ["python"] }).steps).toEqual([
      { tool: "python", action: "upgrade", from: "3.12.10", to: "3.12.16" },
    ]);
  });

  it("removes tools switched off, only when managed", () => {
    const plan = buildPlan({
      desired: [want("bun", "latest", null, false), want("claude", "latest", null, false)],
      observed: [
        have("bun", "1.4.4"),
        have("claude", "2.1.100", { state: "external", backend: null }),
      ],
      latest: info,
    });
    expect(plan.steps).toEqual([{ tool: "bun", action: "remove", from: "1.4.4", to: null }]);
  });

  it("rolls back to the kept previous version, or reports why not", () => {
    const ok = buildPlan({
      desired: [want("claude")],
      observed: [have("claude", "2.1.314", { previousVersion: "2.1.312" })],
      latest: info,
      rollback: ["claude"],
    });
    expect(ok.steps).toEqual([
      { tool: "claude", action: "relink", from: "2.1.314", to: "2.1.312" },
    ]);
    const none = buildPlan({
      desired: [want("claude")],
      observed: [have("claude", "2.1.314")],
      latest: info,
      rollback: ["claude"],
    });
    expect(none.steps).toEqual([]);
    expect(none.errors).toEqual([{ tool: "claude", reason: "no previous version is kept" }]);
  });

  it("reinstall re-runs the install at the resolved version", () => {
    const plan = buildPlan({
      desired: [want("bun")],
      observed: [have("bun", "1.4.4")],
      latest: info,
      reinstall: ["bun"],
    });
    expect(plan.steps).toEqual([{ tool: "bun", action: "reinstall", from: "1.4.4", to: "1.4.4" }]);
  });

  it("unresolvable targets: error when nothing is installed, skip when something works", () => {
    const missing = buildPlan({ desired: [want("codex")], observed: [], latest: {} });
    expect(missing.errors).toHaveLength(1);
    const keeps = buildPlan({
      desired: [want("codex")],
      observed: [have("codex", "0.1.0")],
      latest: {},
    });
    expect(keeps.errors).toEqual([]);
    expect(keeps.skipped).toHaveLength(1);
  });

  it("skips catalog entries an admin disabled", () => {
    const plan = buildPlan({
      desired: [want("grok")],
      observed: [],
      latest: {},
      disabled: ["grok"],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toEqual([{ tool: "grok", reason: "disabled by an administrator" }]);
  });

  it("failed state with a managed install is still managed", () => {
    expect(isManaged(have("bun", "1.4.4", { state: "failed" }))).toBe(true);
    expect(isManaged(have("bun", "1.4.4", { state: "external", backend: null }))).toBe(false);
  });

  it("reports updates only for managed tools that follow releases", () => {
    const bun = requireEntry("bun");
    expect(
      updateAvailable(
        bun,
        { channel: "latest", pinnedVersion: null },
        have("bun", "1.4.3"),
        info.bun,
      ),
    ).toBe("1.4.4");
    expect(
      updateAvailable(
        bun,
        { channel: "latest", pinnedVersion: null },
        have("bun", "1.4.4"),
        info.bun,
      ),
    ).toBeNull();
    expect(
      updateAvailable(bun, { channel: "latest", pinnedVersion: null }, have("bun", null), info.bun),
    ).toBeNull();
  });
});

describe("toAgentStep", () => {
  it("produces a schema-valid install step with ordered backends and bins", () => {
    const step = toAgentStep(
      { tool: "codex", action: "install", from: null, to: "0.163.0" },
      undefined,
    );
    expect(agentStepSchema.parse(step)).toMatchObject({
      tool: "codex",
      action: "install",
      version: "0.163.0",
      backends: [{ spec: "aqua:openai/codex" }, { spec: "npm:@openai/codex" }],
      bins: [{ name: "codex", optional: false }],
    });
  });

  it("muse carries the channel manifest url and checksum as backend options", () => {
    const step = toAgentStep(
      { tool: "muse", action: "install", from: null, to: "1.4.14-R7309.1" },
      {
        latest: "1.4.14-R7309.1",
        lts: null,
        versions: [],
        meta: { url: "https://x.example/muse?a=b&c=d", checksum: `sha256:${"c".repeat(64)}` },
      },
    );
    expect(agentStepSchema.parse(step).bins).toEqual([
      { name: "muse", file: "download", optional: false },
    ]);
    expect(step.backends[0]?.options?.checksum).toBe(`sha256:${"c".repeat(64)}`);
  });

  it("every catalog entry yields a valid install, relink, remove and verify step", () => {
    for (const e of CATALOG) {
      for (const action of ["install", "upgrade", "relink", "remove", "verify"] as const) {
        const step = toAgentStep({ tool: e.id, action, from: null, to: "1.2.3" }, undefined);
        expect(() => agentStepSchema.parse(step), `${e.id}/${action}`).not.toThrow();
      }
    }
  });

  it("the wire schema rejects shell-shaped input", () => {
    const base = toAgentStep(
      { tool: "bun", action: "install", from: null, to: "1.4.4" },
      undefined,
    );
    const bad = (patch: object) =>
      toolchainApplyRequestSchema.safeParse({
        runId: "r1",
        mode: "apply",
        steps: [{ ...base, ...patch }],
      }).success;
    expect(bad({})).toBe(true);
    expect(bad({ version: "1.0; rm -rf /" })).toBe(false);
    expect(bad({ version: null })).toBe(false);
    expect(bad({ backends: [{ spec: "npm:@x/y; id" }] })).toBe(false);
    expect(bad({ backends: [{ spec: "http:muse", options: { url: "http://x" } }] })).toBe(false);
    expect(bad({ backends: [{ spec: "http:muse", options: { bin_path: "." } }] })).toBe(false);
    expect(bad({ bins: [{ name: "../evil", optional: false }] })).toBe(false);
    expect(bad({ versionArgs: ["--version; id"] })).toBe(false);
    expect(
      toolchainApplyRequestSchema.safeParse({ runId: "../x", mode: "apply", steps: [] }).success,
    ).toBe(false);
  });
});

describe("fetchLatestInfo", () => {
  const body = (b: unknown) => ({
    ok: true,
    status: 200,
    json: async () => b,
    text: async () => String(b),
  });
  it("reads node from nodejs.org and trims to the keep limit", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url) => {
      seen.push(url);
      return body(nodeIndex);
    };
    const r = await fetchLatestInfo(requireEntry("node"), f);
    expect(seen).toEqual(["https://nodejs.org/dist/index.json"]);
    expect(r.lts).toBe("26.13.0");
  });

  it("encodes scoped npm package names and asks for the abbreviated document", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> | undefined;
    const f: FetchLike = async (url, init) => {
      seenUrl = url;
      seenHeaders = init?.headers;
      return body({ "dist-tags": { latest: "1.0.105" }, versions: { "1.0.105": {} } });
    };
    const r = await fetchLatestInfo(requireEntry("copilot"), f);
    expect(seenUrl).toBe("https://registry.npmjs.org/@github%2Fcopilot");
    expect(seenHeaders?.accept).toContain("install-v1");
    expect(r.latest).toBe("1.0.105");
  });

  it("surfaces HTTP errors", async () => {
    const f: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    });
    await expect(fetchLatestInfo(requireEntry("bun"), f)).rejects.toThrow("HTTP 503");
  });

  it("muse: channel then manifest", async () => {
    const f: FetchLike = async (url) =>
      url.includes("channels")
        ? body({ version: "1.4.14-R7309.1", manifest_url: "https://m.example/manifest.json" })
        : body({
            version: "1.4.14-R7309.1",
            artifacts: { x86_linux: { url: "https://m.example/muse", checksum: "d".repeat(64) } },
          });
    const r = await fetchLatestInfo(requireEntry("muse"), f);
    expect(r.meta?.checksum).toBe(`sha256:${"d".repeat(64)}`);
  });
});

describe("manifest and image gate", () => {
  it("builds the manifest from versions.json; older images have none", () => {
    expect(
      manifestFromVersions({
        t3: {},
        node: "v24",
        codex: "x",
        claude: "y",
        omp: "z",
        gh: "gh",
        mise: "2026.10.23",
        toolchainAbi: "ubuntu-26.04",
        envVersion: 1,
      }),
    ).toEqual({
      mise: "2026.10.23",
      toolchainAbi: "ubuntu-26.04",
      envVersion: 1,
      slim: false,
      baked: ["node", "claude", "codex", "omp"],
    });
    expect(
      manifestFromVersions({
        t3: {},
        mise: "2026.10.23",
        toolchainAbi: "ubuntu-26.04",
        envVersion: 1,
        slim: true,
      })?.baked,
    ).toEqual([]);
    expect(manifestFromVersions({ t3: {}, node: "v24", codex: "x" })).toBeNull();
    expect(imageManifestSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("orders distro ABIs", () => {
    expect(abiIsOlder("ubuntu-24.04", "ubuntu-26.04")).toBe(true);
    expect(abiIsOlder("ubuntu-26.04", "ubuntu-24.04")).toBe(false);
    expect(abiIsOlder("ubuntu-26.04", "ubuntu-26.04")).toBe(false);
    expect(abiIsOlder("debian-12", "ubuntu-26.04")).toBe(true);
  });

  const slim = {
    mise: "2026.10.23",
    toolchainAbi: "ubuntu-26.04",
    envVersion: 1,
    slim: true,
    baked: [],
  };
  const reconciled = {
    slug: "alice",
    toolchainGeneration: 3,
    toolchainAppliedGeneration: 3,
    toolchainReconciledAt: new Date("2026-10-01T00:00:00Z"),
    toolchainAbi: "ubuntu-26.04",
    tools: [
      {
        toolId: "node",
        desired: true,
        state: "idle",
        installedVersion: "26.13.0",
        backend: "node",
      },
      {
        toolId: "claude",
        desired: true,
        state: "idle",
        installedVersion: "2.1.314",
        backend: "aqua:anthropics/claude-code",
      },
      { toolId: "bun", desired: false, state: "idle", installedVersion: null, backend: null },
    ],
  } as const;

  it("a fully reconciled workspace passes the slim gate", () => {
    expect(evaluateImageGate(slim, { ...reconciled, tools: [...reconciled.tools] })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("blocks when no reconcile ever succeeded, with reasons", () => {
    const v = evaluateImageGate(slim, {
      ...reconciled,
      toolchainReconciledAt: null,
      tools: [...reconciled.tools],
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("No toolchain reconcile has succeeded yet.");
  });

  it("blocks pending generations, external and failed tools", () => {
    const v = evaluateImageGate(slim, {
      ...reconciled,
      toolchainAppliedGeneration: 2,
      tools: [
        { toolId: "node", desired: true, state: "external", installedVersion: null, backend: null },
        { toolId: "claude", desired: true, state: "failed", installedVersion: null, backend: null },
        { toolId: "codex", desired: true, state: "pending", installedVersion: null, backend: null },
      ],
    });
    expect(v.reasons).toEqual([
      "A toolchain change has not been applied yet.",
      "node is still provided by the image.",
      "claude failed to install.",
      "codex is not installed in the workspace.",
    ]);
  });

  it("a failed upgrade on top of a working install still blocks", () => {
    const v = evaluateImageGate(slim, {
      ...reconciled,
      tools: [
        {
          toolId: "claude",
          desired: true,
          state: "failed",
          installedVersion: "2.1.312",
          backend: "aqua:anthropics/claude-code",
        },
      ],
    });
    expect(v.reasons).toEqual(["claude failed its last change."]);
  });

  it("blocks an image older than the installed toolchain ABI; non-slim images skip the toolchain checks", () => {
    const old = { ...slim, slim: false, toolchainAbi: "ubuntu-24.04" };
    const v = evaluateImageGate(old, { ...reconciled, toolchainReconciledAt: null, tools: [] });
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain("ubuntu-24.04");
    expect(
      evaluateImageGate(
        { ...slim, slim: false },
        { ...reconciled, toolchainReconciledAt: null, tools: [] },
      ).ok,
    ).toBe(true);
    expect(
      evaluateImageGate(null, { ...reconciled, toolchainReconciledAt: null, tools: [] }).ok,
    ).toBe(true);
  });

  it("a slim image without mise cannot be reconciled onto", () => {
    expect(
      evaluateImageGate({ ...slim, mise: null }, { ...reconciled, tools: [...reconciled.tools] })
        .reasons,
    ).toEqual(["The image has no mise, so the toolchain cannot be reconciled on it."]);
  });
});

describe("toolchain setting", () => {
  it("validates defaults and disabled", () => {
    const s = parseSetting("toolchain", {
      defaults: [
        { tool: "node", channel: "lts" },
        { tool: "python", channel: "pin", pinnedVersion: "3.12" },
      ],
    });
    expect(s.disabled).toEqual([]);
    expect(() =>
      parseSetting("toolchain", { defaults: [{ tool: "emacs", channel: "latest" }] }),
    ).toThrow();
    expect(() =>
      parseSetting("toolchain", {
        defaults: [{ tool: "node", channel: "pin", pinnedVersion: "1; id" }],
      }),
    ).toThrow();
  });
});
