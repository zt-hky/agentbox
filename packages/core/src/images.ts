/**
 * Whether a workspace can start from an image row. A `retired` image stays usable until its rootfs
 * is deleted (the delete job clears `rootfsPath`); `building` and `failed` rows never are.
 */
export function isImageUsable(row: {
  status: string;
  imageId: string | null;
  rootfsPath: string | null;
}): boolean {
  if (!row.imageId) return false;
  if (row.status === "ready" || row.status === "active") return true;
  return row.status === "retired" && row.rootfsPath !== null;
}

/** Workspace statuses in which a container exists and holds the image's rootfs open. */
export const CONTAINER_UP_STATUSES = ["running", "starting", "stopping"] as const;

/** Workspaces that are gone or going away never block image changes. */
export const WORKSPACE_GONE_STATUSES = ["deleting", "deleted"] as const;
