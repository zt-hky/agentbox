import { formatImageVersion, isImageUsable } from "@agentbox/core/images";
import { extractVersions } from "./system";

/** What the admin UI needs to name an image; safe to ship to client components. */
export interface ImageOption {
  /** images.id */
  id: string;
  /** Build number; its 3-digit form (`007`) is the Podman tag. */
  version: number;
  /** Podman image id (null while building). */
  imageId: string | null;
  t3Ref: string;
  /** T3 ref/commit from the build's versions.json, when the log has it. */
  t3Version: string | null;
  status: string;
  createdAt: string;
}

/** `7` -> `007`, the version shown in the admin UI and used as the Podman tag. */
export const imageVersionLabel = (version: number) => formatImageVersion(version);

export const shortImageId = (imageId: string | null | undefined) =>
  imageId ? imageId.slice(0, 12) : "none";

export function t3VersionOf(buildLog: string | null | undefined): string | null {
  return extractVersions(buildLog)?.find((v) => v.label === "t3")?.value ?? null;
}

export function imageOption(row: {
  id: string;
  version: number;
  imageId: string | null;
  t3Ref: string;
  status: string;
  buildLog: string | null;
  createdAt: Date;
}): ImageOption {
  return {
    id: row.id,
    version: row.version,
    imageId: row.imageId,
    t3Ref: row.t3Ref,
    t3Version: t3VersionOf(row.buildLog),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export type WorkspaceImageState =
  /** Runs the active image and follows it. */
  | "active"
  /** Follows the active image but last started from another one. */
  | "outdated"
  /** Pinned, and the container runs (or will start with) the pinned image. */
  | "pinned"
  /** Pinned to an image other than the one it last started with: applies on next start. */
  | "pinned-pending"
  /** Never started or its image row no longer exists. */
  | "unknown";

export function workspaceImageState(
  ws: { imageId: string | null; pinnedImageId: string | null },
  all: Pick<ImageOption, "id" | "imageId" | "status">[],
): WorkspaceImageState {
  if (ws.pinnedImageId) {
    const pinned = all.find((i) => i.id === ws.pinnedImageId);
    return pinned && pinned.imageId === ws.imageId ? "pinned" : "pinned-pending";
  }
  if (!ws.imageId) return "unknown";
  const active = all.find((i) => i.status === "active");
  if (!active) return "unknown";
  return active.imageId === ws.imageId ? "active" : "outdated";
}

/** Images a workspace may be pinned to. */
export function isPinnable(row: Parameters<typeof isImageUsable>[0]): boolean {
  return isImageUsable(row);
}
