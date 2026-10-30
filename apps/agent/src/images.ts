import { open, readFile, readdir, rename, rm, mkdir, stat } from "node:fs/promises";
import type { BuildImageRequest, BuildImageResponse } from "@agentbox/core/agent-api";
import { imageIdSchema } from "@agentbox/core/agent-api";
import { manifestFromVersions } from "@agentbox/core/toolchain";
import { buildArgv, logToFileArgv, rootfsPath, transportPrefix, trivyArgv } from "./argv.ts";
import {
  BUILD_CONTEXT,
  BUILD_LOG_DIR,
  BUILD_TIMEOUT_MS,
  BUILD_USER,
  IMAGE_REPO,
  ROOTFS_DIR,
  TRIVY_CACHE_DIR,
  TRIVY_IMAGE,
} from "./config.ts";
import { HttpError } from "./errors.ts";
import { pipeProcesses, run, runAs } from "./exec.ts";
import { errMessage, logEvent } from "./log.ts";
import { ensureRootfs } from "./rootfs.ts";
import { lastLines } from "./safe.ts";
import { registry } from "./state.ts";
import { startUserManager } from "./tenants.ts";
import { summarizeTrivy } from "./trivy.ts";

let building: string | null = null;

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The image's own `versions.json`, parsed into the stored manifest; null when absent or unreadable. */
async function readManifest(rootfsDir: string) {
  try {
    const raw: unknown = JSON.parse(
      await readFile(`${rootfsDir}/opt/agentbox/versions.json`, "utf8"),
    );
    return manifestFromVersions(raw);
  } catch {
    return null;
  }
}

export async function buildImage(req: BuildImageRequest): Promise<BuildImageResponse> {
  if (building) throw new HttpError(409, `image build ${building} is already running`);
  building = req.jobId;
  const t0 = Date.now();
  const { jobId } = req;
  const tag = `${IMAGE_REPO}:${jobId}`;
  const container = `abx-export-${jobId}`;
  const logPath = `${BUILD_LOG_DIR}/${jobId}.log`;
  const tmpDir = `${ROOTFS_DIR}/.tmp-${jobId}`;
  let createdDir: string | null = null;
  const bq = (
    argv: string[],
    opts: { check?: boolean; timeoutMs?: number; maxBytes?: number } = {},
  ) => runAs(BUILD_USER, argv, opts);
  const note = (msg: string) =>
    bq(logToFileArgv(logPath, ["echo", `[agentbox-agent] ${msg}`]), { check: false });

  try {
    logEvent({ event: "build_started", jobId });
    const uid = Number((await run("id", ["-u", BUILD_USER])).stdout.trim());
    await startUserManager(uid);
    await bq(["mkdir", "-p", BUILD_LOG_DIR, TRIVY_CACHE_DIR]);
    await bq(["sh", "-c", ': > "$1"', "sh", logPath]);

    await bq(logToFileArgv(logPath, buildArgv(req.t3Ref, tag, BUILD_CONTEXT, req.slim === true)), {
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    const rawId = (
      await bq(["podman", "image", "inspect", "--format", "{{.Id}}", tag])
    ).stdout.trim();
    const parsedId = imageIdSchema.safeParse(rawId.replace(/^sha256:/, ""));
    if (!parsedId.success) throw new Error("podman returned an unexpected image id");
    const imageId = parsedId.data;
    const dir = rootfsPath(imageId);

    if (await exists(dir)) {
      await note(`rootfs ${imageId} already exists; reusing`);
      await ensureRootfs(dir);
    } else {
      await note("exporting rootfs");
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { mode: 0o755 });
      await bq(["podman", "create", "--name", container, tag, "/bin/true"]);
      const [file, ...args] = [...transportPrefix(BUILD_USER), "podman", "export", container];
      await pipeProcesses(
        { file: file as string, args },
        { file: "tar", args: ["-x", "--no-same-owner", "-C", tmpDir] },
        BUILD_TIMEOUT_MS,
      );
      await ensureRootfs(tmpDir);
      await rename(tmpDir, dir);
      createdDir = dir;
    }

    await note("scanning with trivy");
    const scan = await bq(trivyArgv(dir, TRIVY_CACHE_DIR, TRIVY_IMAGE), {
      timeoutMs: 30 * 60_000,
      maxBytes: 512 * 1024 * 1024,
    });
    const scanSummary = summarizeTrivy(scan.stdout);
    await note(`scan summary: ${JSON.stringify(scanSummary)}`);
    createdDir = null;
    logEvent({ event: "build_done", jobId, imageId, durationMs: Date.now() - t0 });
    const manifest = await readManifest(dir);
    return { imageId, scanSummary, logPath, ...(manifest ? { manifest } : {}) };
  } catch (e) {
    await note(`build failed: ${errMessage(e).slice(0, 500)}`).catch(() => undefined);
    if (createdDir) await rm(createdDir, { recursive: true, force: true });
    logEvent({ event: "build_failed", jobId, durationMs: Date.now() - t0 });
    throw e;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    await bq(["podman", "rm", "-f", container], { check: false }).catch(() => undefined);
    await bq(["podman", "rmi", "-f", tag], { check: false }).catch(() => undefined);
    await bq(["podman", "image", "prune", "-f"], { check: false }).catch(() => undefined);
    building = null;
  }
}

export async function readBuildLog(jobId: string, tail: number): Promise<string> {
  const path = `${BUILD_LOG_DIR}/${jobId}.log`;
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    throw new HttpError(404, `no log for job ${jobId}`);
  }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return lastLines(buf.toString("utf8"), tail);
  } finally {
    await fh.close();
  }
}

export async function deleteImage(imageId: string): Promise<void> {
  const users = [...registry.values()].filter((w) => w.imageId === imageId || w.imageId === null);
  if (users.length > 0) {
    throw new HttpError(
      409,
      `image ${imageId} is used by running workspaces: ${users.map((u) => u.ws).join(", ")}`,
    );
  }
  await run("rm", ["-rf", "--one-file-system", "--", rootfsPath(imageId)]);
  logEvent({ event: "image_deleted", imageId });
}

/** Remove half-extracted trees left by an interrupted build. */
export async function cleanStaleRootfsTmp(): Promise<void> {
  for (const name of await readdir(ROOTFS_DIR).catch(() => [] as string[])) {
    if (name.startsWith(".tmp-") && building === null) {
      await run("rm", ["-rf", "--one-file-system", "--", `${ROOTFS_DIR}/${name}`], {
        check: false,
      });
    }
  }
}
