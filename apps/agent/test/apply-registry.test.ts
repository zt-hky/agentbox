import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the real apply.sh against a fake `mise` shim in a throwaway HOME. The shim implements only
 * `latest`, `install`, `ls --json` and `uninstall`, backed by plain directories, which is all the
 * registry path of the script touches.
 */
const APPLY = new URL("../src/toolchain/apply.sh", import.meta.url).pathname;

const MISE_SHIM = `#!/usr/bin/env bash
root=$FAKE_MISE_ROOT
dirfor() { printf '%s/%s/%s' "$root" "\${1//\\//_}" "$2"; }
case $1 in
  latest)
    spec=\${2%%@*}
    [ "$spec" != "$2" ] && { echo "\${2#*@}.9"; exit 0; }
    [ "$spec" = "aqua:fake/missing" ] && exit 1
    echo 1.2.3 ;;
  install)
    t=$2; spec=\${t%%@*}; v=\${t#*@}
    d=$(dirfor "$spec" "$v")
    if [[ $spec == *flat* ]]; then
      mkdir -p "$d"; printf '#!/bin/sh\\necho flat\\n' >"$d/flatcli"; chmod +x "$d/flatcli"
    elif [[ $spec == *empty* ]]; then
      mkdir -p "$d/bin"; : >"$d/bin/notexec"
    else
      mkdir -p "$d/bin"
      printf '#!/bin/sh\\necho foo\\n' >"$d/bin/foo"; chmod +x "$d/bin/foo"
      printf '\\177ELF' >"$d/bin/bar"; chmod +x "$d/bin/bar"
      [[ $spec == *clash* ]] && { printf '#!/bin/sh\\n' >"$d/bin/taken"; chmod +x "$d/bin/taken"; }
      echo data >"$d/bin/readme.txt"
    fi ;;
  ls)
    for d in "$root"/*/*/; do
      [ -d "$d" ] || continue
      printf '%s\\t%s\\t%s\\n' "$(basename "$(dirname "$d")")" "$(basename "$d")" "\${d%/}"
    done | jq -R -s 'split("\\n") | map(select(length > 0) | split("\\t")) | reduce .[] as $r ({}; .[$r[0] | sub("_"; "/")] += [{version: $r[1], installed: true, install_path: $r[2]}])' ;;
  uninstall)
    t=$2; spec=\${t%%@*}; v=\${t#*@}
    rm -rf "$(dirfor "$spec" "$v")" ;;
  *) exit 0 ;;
esac
`;

let home: string;
let root: string;

interface Step {
  tool: string;
  action: "install" | "remove" | "verify";
  version: string | null;
  spec?: string;
}

function run(steps: Step[]) {
  const runDir = join(home, ".agentbox/runs/r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "plan.json"),
    JSON.stringify({
      runId: "r1",
      mode: "apply",
      steps: steps.map((s) => ({
        tool: s.tool,
        action: s.action,
        version: s.version,
        backends: s.spec ? [{ spec: s.spec }] : [],
        bins: [],
        versionArgs: [],
        registry: true,
      })),
    }),
  );
  const r = spawnSync("bash", [APPLY, runDir], {
    env: {
      PATH: `${join(home, "shim")}:${process.env["PATH"] ?? ""}`,
      HOME: home,
      FAKE_MISE_ROOT: root,
    },
    encoding: "utf8",
  });
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as {
    exitCode: number;
    steps: { tool: string; status: string; version?: string; error?: string; errorCode?: string }[];
    tools: Record<string, { version: string; previous: string | null; bins: string[] }>;
  };
  return { ...r, result };
}

const farm = (name: string) => join(home, ".agentbox/bin", name);
const linked = (name: string) => {
  try {
    lstatSync(farm(name));
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "apply-registry-"));
  root = join(home, "fake-mise");
  mkdirSync(join(home, "shim"), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(home, "shim/mise"), MISE_SHIM);
  chmodSync(join(home, "shim/mise"), 0o755);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("apply.sh registry tools", () => {
  it("links every executable of bin/, records them, and uninstall removes exactly those", () => {
    mkdirSync(join(home, ".agentbox/bin"), { recursive: true });
    writeFileSync(join(home, ".agentbox/bin/unrelated"), "keep");

    const i = run([
      { tool: "mise:fake", action: "install", version: "latest", spec: "aqua:fake/tool" },
    ]);
    expect(i.status, i.stdout + i.stderr).toBe(0);
    expect(i.result.steps.find((s) => s.status === "ok")?.version).toBe("1.2.3");
    expect(i.result.tools["mise:fake"]?.bins.sort()).toEqual(["bar", "foo"]);
    expect(i.result.tools["mise:fake"]?.previous).toBeNull();
    expect(linked("foo")).toBe(true);
    expect(linked("bar")).toBe(true);
    expect(linked("readme.txt")).toBe(false);

    const rm = run([{ tool: "mise:fake", action: "remove", version: null }]);
    expect(rm.status, rm.stdout + rm.stderr).toBe(0);
    expect(linked("foo")).toBe(false);
    expect(linked("bar")).toBe(false);
    expect(existsSync(farm("unrelated"))).toBe(true);
    expect(rm.result.tools["mise:fake"]).toBeUndefined();
  });

  it("resolves a pin to the exact version and keeps no previous version on upgrade", () => {
    run([{ tool: "mise:fake", action: "install", version: "latest", spec: "aqua:fake/tool" }]);
    const p = run([{ tool: "mise:fake", action: "install", version: "7", spec: "aqua:fake/tool" }]);
    expect(p.result.tools["mise:fake"]?.version).toBe("7.9");
    expect(p.result.tools["mise:fake"]?.previous).toBeNull();
    expect(existsSync(join(root, "aqua:fake_tool/1.2.3"))).toBe(false);
  });

  it("links executables of the install root when there is no bin/", () => {
    const i = run([
      { tool: "mise:flat", action: "install", version: "latest", spec: "aqua:fake/flat" },
    ]);
    expect(i.status, i.stdout + i.stderr).toBe(0);
    expect(i.result.tools["mise:flat"]?.bins).toEqual(["flatcli"]);
  });

  it("fails when the install has no executable", () => {
    const i = run([
      { tool: "mise:e", action: "install", version: "latest", spec: "aqua:fake/empty" },
    ]);
    expect(i.status).toBe(1);
    expect(i.result.steps.find((s) => s.status === "failed")?.errorCode).toBe("missing_bin");
    expect(i.result.tools["mise:e"]).toBeUndefined();
  });

  it("refuses to overwrite a farm link owned by another tool and leaves it alone", () => {
    run([{ tool: "mise:a", action: "install", version: "latest", spec: "aqua:fake/clash" }]);
    expect(linked("taken")).toBe(true);
    const b = run([
      { tool: "mise:b", action: "install", version: "latest", spec: "aqua:fake/clash2" },
    ]);
    expect(b.status).toBe(1);
    const failed = b.result.steps.find((s) => s.status === "failed");
    expect(failed?.error).toContain("already linked by mise:a");
    expect(b.result.tools["mise:b"]).toBeUndefined();
    expect(linked("foo")).toBe(true);
  });

  it("reports a version that mise cannot resolve", () => {
    const i = run([
      { tool: "mise:m", action: "install", version: "latest", spec: "aqua:fake/missing" },
    ]);
    expect(i.status).toBe(1);
    expect(i.result.steps.find((s) => s.status === "failed")?.errorCode).toBe("version_not_found");
  });

  it("verify: ok when the recorded links exist, skipped otherwise", () => {
    expect(
      run([{ tool: "mise:fake", action: "verify", version: null }]).result.steps[0]?.status,
    ).toBe("skipped");
    run([{ tool: "mise:fake", action: "install", version: "latest", spec: "aqua:fake/tool" }]);
    expect(
      run([{ tool: "mise:fake", action: "verify", version: null }]).result.steps[0]?.status,
    ).toBe("ok");
  });
});
