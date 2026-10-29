import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/worker.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // pg's optional native binding is required lazily inside try/catch.
  external: ["pg-native"],
  // pg and friends are CommonJS; give the ESM bundle a working require().
  banner: {
    js: "import { createRequire as __abxCreateRequire } from 'node:module'; const require = __abxCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
