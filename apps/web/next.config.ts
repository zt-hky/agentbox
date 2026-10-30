import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(here, "../.."),
  transpilePackages: ["@agentbox/core", "@agentbox/db"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  images: { unoptimized: true },
  // The app only ever serves https://app.<base domain>; Server Action Origin checks compare
  // against the Host header, which Caddy forwards unchanged.
  experimental: {
    serverActions: { bodySizeLimit: "256kb" },
  },
  // The Accounts page covers every git host now; the old GitHub-only path keeps working.
  async redirects() {
    return [{ source: "/settings/github", destination: "/settings/accounts", permanent: true }];
  },
};

export default config;
