import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

/** `import script from "./x.sh"` yields the file text, like esbuild's `text` loader in build.mjs. */
const shText: Plugin = {
  name: "sh-text",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0] as string;
    if (!path.endsWith(".sh")) return null;
    return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [shText],
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
