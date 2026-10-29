import { build } from "esbuild";

// Host root daemon: runs on the apt Node 22 (/usr/bin/node), core is bundled in.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/agent.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "info",
});
