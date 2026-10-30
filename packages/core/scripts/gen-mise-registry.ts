/**
 * Regenerates src/toolchain/mise-registry.json from the mise release the workspace image pins.
 *
 *   node packages/core/scripts/gen-mise-registry.ts            (version read from the Containerfile)
 *   node packages/core/scripts/gen-mise-registry.ts 2026.10.23
 *
 * Downloads the linux-x64 release tarball into a temp dir, runs `mise registry --json
 * --hide-aliased` and writes `{ name, backends, aliases?, description? }` entries. Curated catalog
 * tools are left out (by id, alias or shared backend), and so are backends the apply script cannot
 * pass through (`backendSpecSchema`), e.g. asdf git URLs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendSpecSchema } from "../src/toolchain/api.ts";
import { CATALOG } from "../src/toolchain/catalog.ts";
import { REGISTRY_NAME_RE, type RegistryTool } from "../src/toolchain/registry.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here("../src/toolchain/mise-registry.json");

function pinnedVersion(): string {
  const containerfile = readFileSync(here("../../../images/workspace/Containerfile"), "utf8");
  const m = /^ARG MISE_VERSION=(\S+)$/m.exec(containerfile);
  if (!m?.[1]) throw new Error("MISE_VERSION not found in images/workspace/Containerfile");
  return m[1];
}

interface MiseRegistryRow {
  short: string;
  backends?: string[];
  aliases?: string[];
  description?: string | null;
}

const version = process.argv[2] ?? pinnedVersion();
const dir = mkdtempSync(join(tmpdir(), "mise-registry-"));
try {
  const file = `mise-v${version}-linux-x64.tar.gz`;
  const url = `https://github.com/jdx/mise/releases/download/v${version}/${file}`;
  console.log(`downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", join(dir, file), url], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", join(dir, file), "-C", dir, "mise/bin/mise"], { stdio: "inherit" });
  const mise = join(dir, "mise/bin/mise");
  const reported = execFileSync(mise, ["--version"], { encoding: "utf8" });
  if (!reported.startsWith(version)) throw new Error(`expected mise ${version}, got ${reported}`);
  const raw = execFileSync(mise, ["registry", "--json", "--hide-aliased"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MISE_NO_CONFIG: "1" },
  });
  const rows = JSON.parse(raw) as MiseRegistryRow[];

  const curatedIds = new Set<string>(CATALOG.map((e) => e.id));
  const curatedBackends = new Set<string>(CATALOG.flatMap((e) => e.backends.map((b) => b.spec)));

  const out: RegistryTool[] = [];
  for (const row of rows) {
    const backends = (row.backends ?? []).filter((b) => backendSpecSchema.safeParse(b).success);
    const aliases = (row.aliases ?? []).filter((a) => a !== row.short && REGISTRY_NAME_RE.test(a));
    if (!REGISTRY_NAME_RE.test(row.short) || backends.length === 0) continue;
    if (curatedIds.has(row.short) || aliases.some((a) => curatedIds.has(a))) continue;
    if ((row.backends ?? []).some((b) => curatedBackends.has(b))) continue;
    const description = row.description?.replace(/\s+/g, " ").trim();
    out.push({
      name: row.short,
      backends,
      ...(aliases.length > 0 ? { aliases: aliases.sort() } : {}),
      ...(description ? { description } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${out.length} tools (mise ${version}) to ${OUT}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
