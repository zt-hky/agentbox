import { describe, expect, it } from "vitest";
import {
  CATALOG,
  BUNDLED_PACKAGE_MANAGERS,
  REGISTRY,
  catalogEntry,
  registryTool,
  searchRegistry,
  toolIdSchema,
  agentStepSchema,
  abiIsOlder,
  buildPlan,
  compareVersions,
  evaluateImageGate,
  fetchLatestInfo,
  imageManifestSchema,
  isManaged,
  manifestFromVersions,
  packageManagersFor,
  parseMavenMetadata,
  parsePypi,
  parseAdoptium,
  parseGithubReleases,
  parseCrates,
  parseGoProxyList,
  backendVersionSource,
  registryVersionSource,
  fetchRegistryVersions,
  goProxyListUrl,
  parseGoDl,
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

describe("language runtimes: rust, go, java", () => {
  it("are runtimes with mise backends and a version source", () => {
    for (const id of ["rust", "go", "java"] as const) {
      const e = requireEntry(id);
      expect(e.kind).toBe("runtime");
      expect(e.backends[0]!.spec).toBe(id);
      expect(e.bins.some((b) => !b.optional)).toBe(true);
    }
    expect(requireEntry("go").versionArgs).toEqual(["version"]);
    expect(requireEntry("java").channels).toEqual(["lts", "latest", "pin"]);
    expect(CATALOG.map((e) => e.id)).toEqual(expect.arrayContaining(["node", "bun", "python"]));
  });

  it("go: stable releases from go.dev, patchless entries dropped", () => {
    const r = parseGoDl([
      { version: "go1.24.1", stable: true },
      { version: "go1.24.0", stable: true },
      { version: "go1.25rc1", stable: false },
      { version: "go1.23", stable: true },
    ]);
    expect(r).toEqual({ latest: "1.24.1", lts: null, versions: ["1.24.1", "1.24.0"] });
    expect(resolveTarget(requireEntry("go"), "pin", "1.24", r)).toEqual({
      ok: true,
      version: "1.24.1",
    });
  });

  it("rust: release tags, prereleases skipped", () => {
    const r = parseGithubReleases([
      { tag_name: "1.91.0" },
      { tag_name: "1.90.0" },
      { tag_name: "1.92.0-beta.1", prerelease: true },
      { tag_name: "v1.89.0" },
    ]);
    expect(r.latest).toBe("1.91.0");
    expect(r.versions).toEqual(["1.91.0", "1.90.0", "1.89.0"]);
  });

  it("java: latest is the newest GA, lts the newest LTS; pre-17 majors are ignored", () => {
    const r = parseAdoptium({
      versions: [
        { major: 26, minor: 0, security: 1, openjdk_version: "26.0.1+9" },
        { major: 25, minor: 0, security: 2, openjdk_version: "25.0.2+10-LTS" },
        { major: 21, minor: 0, security: 9, semver: "21.0.9+10.0.LTS" },
        { major: 11, minor: 0, security: 29, openjdk_version: "11.0.29+7-LTS" },
      ],
    });
    expect(r).toEqual({
      latest: "26.0.1",
      lts: "25.0.2",
      versions: ["26.0.1", "25.0.2", "21.0.9"],
    });
    expect(resolveTarget(requireEntry("java"), "lts", null, r)).toEqual({
      ok: true,
      version: "25.0.2",
    });
  });

  it("fetchLatestInfo reads each source from its URL", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes("go.dev")
            ? [{ version: "go1.24.1", stable: true }]
            : url.includes("adoptium")
              ? { versions: [] }
              : [{ tag_name: "1.91.0" }],
        text: async () => "",
      };
    };
    expect((await fetchLatestInfo(requireEntry("go"), f)).latest).toBe("1.24.1");
    expect((await fetchLatestInfo(requireEntry("rust"), f)).latest).toBe("1.91.0");
    expect((await fetchLatestInfo(requireEntry("java"), f)).latest).toBeNull();
    expect(seen[0]).toContain("go.dev/dl");
    expect(seen[1]).toBe("https://api.github.com/repos/rust-lang/rust/releases?per_page=100");
    expect(seen[2]).toContain("api.adoptium.net");
  });
});

describe("package managers", () => {
  const ids = ["pnpm", "yarn", "uv", "poetry", "maven", "gradle"] as const;

  it("are package-manager entries that name their language and use explicit mise backends", () => {
    const language = {
      pnpm: "node",
      yarn: "node",
      uv: "python",
      poetry: "python",
      maven: "java",
      gradle: "java",
    };
    for (const id of ids) {
      const e = requireEntry(id);
      expect(e.kind, id).toBe("package-manager");
      expect(e.requires, id).toBe(language[id]);
      expect(requireEntry(e.requires!).kind).toBe("runtime");
      expect(e.backends.length, id).toBeGreaterThan(0);
      for (const b of e.backends) expect(b.spec, id).toMatch(/^(aqua|npm|pypi):/);
      expect(
        e.bins.some((b) => !b.optional),
        id,
      ).toBe(true);
      expect(e.channels, id).toEqual(["latest", "pin"]);
    }
    expect(packageManagersFor("node").map((e) => e.id)).toEqual(["pnpm", "yarn"]);
    expect(packageManagersFor("python").map((e) => e.id)).toEqual(["uv", "poetry"]);
    expect(packageManagersFor("java").map((e) => e.id)).toEqual(["maven", "gradle"]);
    expect(packageManagersFor("rust")).toEqual([]);
    expect(Object.keys(BUNDLED_PACKAGE_MANAGERS).sort()).toEqual([
      "bun",
      "go",
      "node",
      "python",
      "rust",
    ]);
  });

  it("pypi and maven sources: stable releases only, yanked files dropped", () => {
    const py = parsePypi({
      releases: {
        "2.2.1": [{ yanked: false }],
        "2.2.0": [{ yanked: true }],
        "2.3.0rc1": [{}],
        "2.1.4": [{}],
        "1.0.0": [],
      },
    });
    expect(py).toEqual({ latest: "2.2.1", lts: null, versions: ["2.2.1", "2.1.4"] });
    const mvn = parseMavenMetadata(
      "<metadata><versioning><versions><version>3.9.10</version><version>3.9.11</version>" +
        "<version>4.0.0-rc-4</version><version>3.8.8</version></versions></versioning></metadata>",
    );
    expect(mvn).toEqual({ latest: "3.9.11", lts: null, versions: ["3.9.11", "3.9.10", "3.8.8"] });
  });

  it("fetchLatestInfo reads pypi and maven central", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ releases: { "2.2.1": [{}] } }),
        text: async () => "<versions><version>3.9.11</version></versions>",
      };
    };
    expect((await fetchLatestInfo(requireEntry("poetry"), f)).latest).toBe("2.2.1");
    expect((await fetchLatestInfo(requireEntry("maven"), f)).latest).toBe("3.9.11");
    expect(seen).toEqual([
      "https://pypi.org/pypi/poetry/json",
      "https://repo1.maven.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml",
    ]);
  });

  it("install after their language, and are skipped when the language is not wanted", () => {
    const latest = {
      ...info,
      pnpm: { latest: "10.18.0", lts: null, versions: ["10.18.0", "10.17.1"] },
      uv: { latest: "0.9.5", lts: null, versions: ["0.9.5"] },
    } as Partial<Record<ToolId, LatestInfo>>;
    const plan = buildPlan({
      desired: [want("claude"), want("pnpm"), want("node", "lts"), want("uv"), want("python")],
      observed: [],
      latest,
    });
    expect(plan.steps.map((s) => s.tool)).toEqual(["node", "python", "pnpm", "uv", "claude"]);
    expect(plan.steps.find((s) => s.tool === "pnpm")?.to).toBe("10.18.0");
    const orphan = buildPlan({
      desired: [want("pnpm"), want("node", "lts", null, false)],
      observed: [],
      latest,
    });
    expect(orphan.steps).toEqual([]);
    expect(orphan.skipped).toEqual([{ tool: "pnpm", reason: "requires Node.js" }]);
  });

  it("a pinned line resolves to the newest patch of that line", () => {
    const r = parseGithubReleases([
      { tag_name: "0.9.5" },
      { tag_name: "0.9.4" },
      { tag_name: "0.8.22" },
    ]);
    expect(resolveTarget(requireEntry("uv"), "pin", "0.8", r)).toEqual({
      ok: true,
      version: "0.8.22",
    });
    expect(selectableLines(requireEntry("uv"), r.versions).map((l) => l.line)).toEqual([
      "0.9",
      "0.8",
    ]);
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

describe("mise registry", () => {
  const registryId = (name: string) => `mise:${name}` as ToolId;

  it("loads the snapshot without curated tools, with first-backend installs", () => {
    expect(REGISTRY.length).toBeGreaterThan(500);
    const names = new Set(REGISTRY.map((t) => t.name));
    expect(names.size).toBe(REGISTRY.length);
    for (const e of CATALOG) expect(names.has(e.id)).toBe(false);
    const curatedBackends = new Set(CATALOG.flatMap((e) => e.backends.map((b) => b.spec)));
    for (const t of REGISTRY) {
      expect(t.backends.length).toBeGreaterThan(0);
      for (const b of t.backends) expect(curatedBackends.has(b)).toBe(false);
    }
    const rg = REGISTRY.find((t) => t.name === "ripgrep");
    expect(rg?.backends[0]).toMatch(/^aqua:/);
    expect(catalogEntry("mise:ripgrep")).toMatchObject({
      kind: "registry",
      channels: ["latest", "pin"],
      versionSource: { kind: "none" },
      bins: [],
      backends: [{ spec: rg?.backends[0] }],
      sizeHintMb: null,
    });
  });

  it("validates ids: curated, or mise:<name> that exists in the snapshot", () => {
    expect(toolIdSchema.safeParse("node").success).toBe(true);
    expect(toolIdSchema.safeParse("mise:ripgrep").success).toBe(true);
    for (const bad of [
      "mise:",
      "mise:no-such-tool-xyz",
      "mise:Ripgrep",
      "mise:../x",
      "mise:a b",
      "ripgrep",
      "emacs",
      7,
    ]) {
      expect(toolIdSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(registryTool("mise:ripgrep")?.name).toBe("ripgrep");
    expect(registryTool("mise:node")).toBeUndefined();
    expect(catalogEntry("mise:no-such-tool-xyz")).toBeUndefined();
  });

  it("searches name/alias prefix first, then substring, at most 20; empty matches nothing", () => {
    expect(searchRegistry("")).toEqual([]);
    expect(searchRegistry("   ")).toEqual([]);
    const hits = searchRegistry("rip");
    expect(hits.length).toBeLessThanOrEqual(20);
    expect(hits[0]).toMatchObject({ name: "ripgrep", id: "mise:ripgrep" });
    expect(hits[0]?.backend).toMatch(/:/);
    // every prefix match (name or alias) precedes the pure substring matches
    const isPrefix = (n: string) =>
      n.startsWith("rip") ||
      !!REGISTRY.find((t) => t.name === n)?.aliases?.some((a) => a.startsWith("rip"));
    const flags = hits.map((h) => isPrefix(h.name));
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(searchRegistry("RIPGREP")[0]?.name).toBe("ripgrep");
    // an alias finds its tool: `op` is an alias of 1password
    expect(searchRegistry("op").some((h) => h.name === "1password")).toBe(true);
    expect(searchRegistry("e")).toHaveLength(20);
    expect(searchRegistry("grep").map((h) => h.name)).toContain("ripgrep");
  });

  it("maps a backend to a version source", () => {
    expect(backendVersionSource("aqua:BurntSushi/ripgrep")).toEqual({
      kind: "github-releases",
      repo: "BurntSushi/ripgrep",
    });
    expect(backendVersionSource("aqua:bazelbuild/buildtools/buildifier")).toEqual({
      kind: "github-releases",
      repo: "bazelbuild/buildtools",
    });
    expect(backendVersionSource("github:o/r[exe=x]")).toEqual({
      kind: "github-releases",
      repo: "o/r",
    });
    expect(backendVersionSource("ubi:o/r")).toEqual({ kind: "github-releases", repo: "o/r" });
    expect(backendVersionSource("npm:@biomejs/biome")).toEqual({
      kind: "npm",
      pkg: "@biomejs/biome",
    });
    expect(backendVersionSource("pipx:ansible")).toEqual({ kind: "pypi", pkg: "ansible" });
    expect(backendVersionSource("pypi:ansible")).toEqual({ kind: "pypi", pkg: "ansible" });
    expect(backendVersionSource("cargo:bat")).toEqual({ kind: "crates", crate: "bat" });
    expect(backendVersionSource("go:github.com/rhysd/actionlint/cmd/actionlint")).toEqual({
      kind: "go-proxy",
      module: "github.com/rhysd/actionlint",
    });
    expect(backendVersionSource("go:github.com/onsi/ginkgo/v2/ginkgo")).toEqual({
      kind: "go-proxy",
      module: "github.com/onsi/ginkgo/v2",
    });
    for (const none of [
      "core:java",
      "asdf:x",
      "vfox:x",
      "http:x",
      "conda:x",
      "aqua:atlassian.com",
      "npm:../x",
      "cargo:a b",
      "go:golang.org/x/tools/cmd/goimports",
      "nocolon",
    ]) {
      expect(backendVersionSource(none), none).toBeUndefined();
    }
  });

  it("takes the first backend that has a source and covers most of the registry", () => {
    expect(registryVersionSource("mise:ripgrep")).toMatchObject({ kind: "github-releases" });
    expect(registryVersionSource("mise:no-such-tool-xyz")).toBeUndefined();
    const covered = REGISTRY.filter((t) => registryVersionSource(`mise:${t.name}`)).length;
    expect(covered / REGISTRY.length).toBeGreaterThan(0.8);
  });

  it("parses crates.io and the go proxy; yanked, pre-releases and pseudo-versions drop out", () => {
    const c = parseCrates({
      versions: [
        { num: "1.2.0" },
        { num: "1.3.0", yanked: true },
        { num: "1.4.0-rc.1" },
        { num: "1.1.9" },
      ],
    });
    expect(c).toEqual({ latest: "1.2.0", lts: null, versions: ["1.2.0", "1.1.9"] });
    const g = parseGoProxyList(
      "v1.9.0\nv1.10.2\nv1.11.0-rc1\nv0.0.0-20240101000000-abcdef123456\nv1.10.1+incompatible\n",
    );
    expect(g.versions).toEqual(["1.10.2", "1.9.0"]);
    expect(g.latest).toBe("1.10.2");
    expect(goProxyListUrl("github.com/Azure/azure")).toBe(
      "https://proxy.golang.org/github.com/!azure/azure/@v/list",
    );
  });

  it("strips <name>- tag prefixes from github releases", () => {
    const r = parseGithubReleases([
      { tag_name: "jq-1.7.1" },
      { tag_name: "release-v1.7.0" },
      { tag_name: "v1.6.0" },
      { tag_name: "nightly" },
      { tag_name: "jq-1.8.0-rc1" },
    ]);
    expect(r.versions).toEqual(["1.7.1", "1.7.0", "1.6.0"]);
  });

  it("fetches registry versions through the derived source (50 max) and rejects tools without one", async () => {
    const urls: string[] = [];
    const tags = Array.from({ length: 80 }, (_, i) => ({ tag_name: `v1.${i}.0` }));
    const f: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => tags, text: async () => "" };
    };
    const info = await fetchRegistryVersions("mise:ripgrep", f);
    expect(urls[0]).toMatch(/^https:\/\/api\.github\.com\/repos\/BurntSushi\/ripgrep\/releases/);
    expect(info.versions).toHaveLength(50);
    expect(info.versions[0]).toBe("1.79.0");
    const none = REGISTRY.find((t) => !registryVersionSource(`mise:${t.name}`));
    await expect(fetchRegistryVersions(`mise:${none!.name}`, f)).rejects.toThrow(
      /no version source/,
    );
  });

  it("plans install, pin drift and upgrade (reinstalls latest) without published versions", () => {
    const id = registryId("ripgrep");
    const w = (channel: "latest" | "pin", pinnedVersion: string | null = null): DesiredRow => ({
      toolId: id,
      channel,
      pinnedVersion,
      desired: true,
    });
    const o = (installed: string): ObservedRow => ({
      toolId: id,
      state: "idle",
      installedVersion: installed,
      previousVersion: null,
      backend: "aqua:BurntSushi/ripgrep",
    });
    const plan = (input: Partial<Parameters<typeof buildPlan>[0]> & { desired: DesiredRow[] }) =>
      buildPlan({ observed: [], latest: {}, ...input }).steps;
    expect(plan({ desired: [w("latest")] })).toEqual([
      { tool: id, action: "install", from: null, to: "latest" },
    ]);
    expect(plan({ desired: [w("pin", "14.1")] })).toEqual([
      { tool: id, action: "install", from: null, to: "14.1" },
    ]);
    // a pinned line is satisfied by any patch; a different pin is a change
    expect(plan({ desired: [w("pin", "14.1")], observed: [o("14.1.1")] })).toEqual([]);
    expect(plan({ desired: [w("pin", "13")], observed: [o("14.1.1")] })).toHaveLength(1);
    // no automatic upgrade; an upgrade request reinstalls latest; pins are left alone
    expect(plan({ desired: [w("latest")], observed: [o("14.1.1")] })).toEqual([]);
    expect(plan({ desired: [w("latest")], observed: [o("14.1.1")], upgrade: [id] })).toEqual([
      { tool: id, action: "upgrade", from: "14.1.1", to: "latest" },
    ]);
    expect(plan({ desired: [w("pin", "14.1")], observed: [o("14.1.1")], upgrade: [id] })).toEqual(
      [],
    );
    // never shows an update: there is no version source
    expect(updateAvailable(requireEntry(id), w("latest"), o("1.0.0"), undefined)).toBeNull();
    // curated tools stay ahead of registry tools
    expect(
      plan({ desired: [w("latest"), want("claude")], latest: info }).map((s) => s.tool),
    ).toEqual(["claude", id]);
    // removal of a no-longer-desired registry tool
    expect(
      plan({ desired: [{ ...w("latest"), desired: false }], observed: [o("14.1.1")] }),
    ).toEqual([{ tool: id, action: "remove", from: "14.1.1", to: null }]);
  });

  it("rejects a bad pinned version and builds a schema-valid registry step without bins", () => {
    const id = registryId("ripgrep");
    expect(resolveTarget(requireEntry(id), "pin", "1;id", undefined)).toMatchObject({ ok: false });
    expect(resolveTarget(requireEntry(id), "pin", "-1", undefined)).toMatchObject({ ok: false });
    expect(resolveTarget(requireEntry(id), "lts", null, undefined)).toEqual({
      ok: true,
      version: "latest",
    });
    const step = toAgentStep({ tool: id, action: "install", from: null, to: "latest" }, undefined);
    const parsed = agentStepSchema.parse(step);
    expect(parsed).toMatchObject({ tool: id, version: "latest", registry: true, bins: [] });
    expect(parsed.backends).toHaveLength(1);
    // curated steps still need bins
    expect(agentStepSchema.safeParse({ ...step, tool: "node", registry: false }).success).toBe(
      false,
    );
  });
});
