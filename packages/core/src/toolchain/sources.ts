import type { CatalogEntry } from "./catalog.ts";
import {
  MUSE_CHANNEL_URL,
  parseMuseChannel,
  parseMuseManifest,
  parseNodeIndex,
  parseNpmPackument,
  parsePythonList,
  versionsToKeep,
  type LatestInfo,
} from "./versions.ts";

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;

export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
export const PYTHON_VERSIONS_URL = "https://mise-versions.jdx.dev/python";
export const npmPackumentUrl = (pkg: string) =>
  `https://registry.npmjs.org/${pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : pkg}`;

async function ok(res: FetchResponse, url: string): Promise<FetchResponse> {
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  return res;
}

/**
 * Resolve what is published for a tool from its authoritative source. The central worker does
 * this (not the workspace), so tenants sharing one egress IP never hit GitHub's anonymous rate
 * limit just to learn the latest version.
 */
export async function fetchLatestInfo(
  entry: CatalogEntry,
  fetchImpl: FetchLike,
): Promise<LatestInfo> {
  const src = entry.versionSource;
  let info: LatestInfo;
  switch (src.kind) {
    case "node-dist": {
      const res = await ok(await fetchImpl(NODE_INDEX_URL), NODE_INDEX_URL);
      info = parseNodeIndex(await res.json());
      break;
    }
    case "python-mise": {
      const res = await ok(await fetchImpl(PYTHON_VERSIONS_URL), PYTHON_VERSIONS_URL);
      info = parsePythonList(await res.text());
      break;
    }
    case "npm": {
      const url = npmPackumentUrl(src.pkg);
      const res = await ok(
        await fetchImpl(url, { headers: { accept: "application/vnd.npm.install-v1+json" } }),
        url,
      );
      info = parseNpmPackument(await res.json());
      break;
    }
    case "muse-channel": {
      const res = await ok(await fetchImpl(MUSE_CHANNEL_URL), MUSE_CHANNEL_URL);
      const channel = parseMuseChannel(await res.json());
      const manifest = await ok(await fetchImpl(channel.manifestUrl), channel.manifestUrl);
      info = parseMuseManifest(await manifest.json());
      break;
    }
  }
  return { ...info, versions: info.versions.slice(0, versionsToKeep(entry)) };
}
