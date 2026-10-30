import type { CatalogEntry } from "./catalog.ts";
import {
  MUSE_CHANNEL_URL,
  parseMuseChannel,
  parseAdoptium,
  parseMavenMetadata,
  parsePypi,
  parseGithubReleases,
  parseGoDl,
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
export const GO_DL_URL = "https://go.dev/dl/?mode=json&include=all";
export const ADOPTIUM_URL =
  "https://api.adoptium.net/v3/info/release_versions?release_type=ga&image_type=jdk&architecture=x64&os=linux&vendor=eclipse&page_size=50&sort_order=DESC";
export const githubReleasesUrl = (repo: string) =>
  `https://api.github.com/repos/${repo}/releases?per_page=100`;
export const PYTHON_VERSIONS_URL = "https://mise-versions.jdx.dev/python";
export const npmPackumentUrl = (pkg: string) =>
  `https://registry.npmjs.org/${pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : pkg}`;
export const pypiJsonUrl = (pkg: string) => `https://pypi.org/pypi/${pkg}/json`;
export const mavenMetadataUrl = (group: string, artifact: string) =>
  `https://repo1.maven.org/maven2/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`;

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
    case "pypi": {
      const url = pypiJsonUrl(src.pkg);
      const res = await ok(await fetchImpl(url), url);
      info = parsePypi(await res.json());
      break;
    }
    case "maven-central": {
      const url = mavenMetadataUrl(src.group, src.artifact);
      const res = await ok(await fetchImpl(url), url);
      info = parseMavenMetadata(await res.text());
      break;
    }
    case "go-dl": {
      const res = await ok(await fetchImpl(GO_DL_URL), GO_DL_URL);
      info = parseGoDl(await res.json());
      break;
    }
    case "adoptium": {
      const res = await ok(await fetchImpl(ADOPTIUM_URL), ADOPTIUM_URL);
      info = parseAdoptium(await res.json());
      break;
    }
    case "github-releases": {
      const url = githubReleasesUrl(src.repo);
      const res = await ok(
        await fetchImpl(url, { headers: { accept: "application/vnd.github+json" } }),
        url,
      );
      info = parseGithubReleases(await res.json());
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
