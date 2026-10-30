import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  CONTAINER_UP_STATUSES,
  MAX_IMAGE_VERSION,
  WORKSPACE_GONE_STATUSES,
  isImageUsable,
} from "@agentbox/core/images";
import {
  evaluateImageGate,
  parseImageManifest,
  type GateWorkspace,
} from "@agentbox/core/toolchain";
import { requestReconcile } from "@agentbox/db/toolchain";
import { images, jobs, workspaceTools, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "../audit";
import type { Db, DbLike } from "../db-types";
import { UserError } from "../errors";
import { activationOverride } from "../images";

type ImageRow = typeof images.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

export interface ImageActor {
  adminId: string;
  ip: string | null;
}

/**
 * Insert a `building` image row with the next build number (max + 1, never reused). The unique
 * index on `images.version` turns two racing inserts into a retryable error.
 */
export async function allocateImage(
  database: DbLike,
  input: { t3Ref: string; createdBy: string | null },
): Promise<{ id: string; version: number }> {
  try {
    const [row] = await database
      .insert(images)
      .values({
        t3Ref: input.t3Ref,
        status: "building",
        createdBy: input.createdBy,
        version: sql`(select coalesce(max(${images.version}), 0) + 1 from ${images})`,
      })
      .returning({ id: images.id, version: images.version });
    if (!row) throw new Error("could not allocate an image row");
    if (row.version > MAX_IMAGE_VERSION) {
      throw new UserError(`Build numbers are 3 digits; ${MAX_IMAGE_VERSION} images already exist`);
    }
    return row;
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code;
    if (code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      throw new UserError("Another build was just queued; try again");
    }
    throw e;
  }
}

export type MoveMode = "none" | "running" | "all";

const goneStatuses = [...WORKSPACE_GONE_STATUSES];
const upStatuses = [...CONTAINER_UP_STATUSES];

const isUp = (ws: { status: string }) => (upStatuses as string[]).includes(ws.status);

export interface ImageUserRef {
  slug: string;
  status: string;
}

export interface ImageUsage {
  /** Containers up (running/starting/stopping) from this image: block deletion. */
  running: ImageUserRef[];
  /** Other live workspaces whose last start used this image (asleep or errored). */
  sleeping: ImageUserRef[];
  /** Workspaces pinned to this image by an admin. */
  pinned: ImageUserRef[];
}

export interface ImageOverviewRow {
  image: ImageRow;
  /** Live workspaces this image's toolchain gate rejects (empty for images without a gate). */
  gate: GateFailure[];
  usage: ImageUsage;
  deleteQueued: boolean;
  lastDeleteError: string | null;
}

export interface WorkspaceImageRef {
  slug: string;
  status: string;
  /** Podman id it last started with. */
  imageId: string | null;
  pinnedImageId: string | null;
}

export interface GateFailure {
  slug: string;
  reasons: string[];
}

/** Gate inputs of live workspaces (their tools and toolchain columns), optionally limited to `slugs`. */
async function loadGateWorkspaces(
  database: DbLike,
  slugs?: readonly string[],
): Promise<GateWorkspace[]> {
  if (slugs && slugs.length === 0) return [];
  const where = slugs
    ? and(notInArray(workspaces.status, goneStatuses), inArray(workspaces.slug, [...slugs]))
    : notInArray(workspaces.status, goneStatuses);
  const rows = await database
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      toolchainGeneration: workspaces.toolchainGeneration,
      toolchainAppliedGeneration: workspaces.toolchainAppliedGeneration,
      toolchainReconciledAt: workspaces.toolchainReconciledAt,
      toolchainAbi: workspaces.toolchainAbi,
    })
    .from(workspaces)
    .where(where)
    .orderBy(workspaces.slug);
  if (rows.length === 0) return [];
  const tools = await database
    .select({
      workspaceId: workspaceTools.workspaceId,
      toolId: workspaceTools.toolId,
      desired: workspaceTools.desired,
      state: workspaceTools.state,
      installedVersion: workspaceTools.installedVersion,
      backend: workspaceTools.backend,
    })
    .from(workspaceTools)
    .where(
      inArray(
        workspaceTools.workspaceId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map(({ id, ...ws }) => ({
    ...ws,
    tools: tools.filter((t) => t.workspaceId === id),
  }));
}

function gateFailures(image: Pick<ImageRow, "manifest">, wss: readonly GateWorkspace[]) {
  const manifest = parseImageManifest(image.manifest);
  if (!manifest) return [];
  const out: GateFailure[] = [];
  for (const ws of wss) {
    const verdict = evaluateImageGate(manifest, ws);
    if (!verdict.ok) out.push({ slug: ws.slug, reasons: verdict.reasons });
  }
  return out;
}

/**
 * Live workspaces (or just `slugs`) that the image's manifest gate rejects: a slim image needs a
 * completed toolchain reconcile, and an image with an older ABI than the installed toolchain is
 * refused. Images without a manifest (built before the toolchain) are never gated.
 */
export async function evaluateWorkspaceGates(
  database: DbLike,
  image: Pick<ImageRow, "manifest">,
  slugs?: readonly string[],
): Promise<GateFailure[]> {
  if (!parseImageManifest(image.manifest)) return [];
  return gateFailures(image, await loadGateWorkspaces(database, slugs));
}

const MAX_GATE_LISTED = 8;

function assertGate(image: ImageRow, failures: GateFailure[], what: string): void {
  if (failures.length === 0) return;
  const listed = failures
    .slice(0, MAX_GATE_LISTED)
    .map((f) => `${f.slug}: ${f.reasons.join(" ")}`)
    .join(" | ");
  const more =
    failures.length > MAX_GATE_LISTED ? ` (+${failures.length - MAX_GATE_LISTED} more)` : "";
  throw new UserError(`Cannot ${what} image ${image.t3Ref}. ${listed}${more}`);
}

/** Live (not deleting/deleted) workspaces with the fields needed for image decisions. */
export async function listLiveWorkspaceImages(database: DbLike): Promise<WorkspaceImageRef[]> {
  return database
    .select({
      slug: workspaces.slug,
      status: workspaces.status,
      imageId: workspaces.imageId,
      pinnedImageId: workspaces.pinnedImageId,
    })
    .from(workspaces)
    .where(notInArray(workspaces.status, goneStatuses))
    .orderBy(workspaces.slug);
}

export function usageOf(image: ImageRow, live: WorkspaceImageRef[]): ImageUsage {
  const usage: ImageUsage = { running: [], sleeping: [], pinned: [] };
  for (const w of live) {
    const ref = { slug: w.slug, status: w.status };
    if (w.pinnedImageId === image.id) usage.pinned.push(ref);
    if (image.imageId && w.imageId === image.imageId) {
      (isUp(w) ? usage.running : usage.sleeping).push(ref);
    }
  }
  return usage;
}

function blockersOf(image: ImageRow, usage: ImageUsage, deleteQueued: boolean): string[] {
  const out: string[] = [];
  if (image.status === "active") out.push("It is the active image; activate another one first.");
  if (image.status === "building") out.push("A build is running.");
  if (usage.pinned.length > 0)
    out.push(
      `Pinned by ${usage.pinned.length} workspace(s): ${usage.pinned.map((w) => w.slug).join(", ")}.`,
    );
  if (usage.running.length > 0)
    out.push(
      `Running ${usage.running.length} workspace(s): ${usage.running.map((w) => w.slug).join(", ")}.`,
    );
  if (deleteQueued) out.push("A delete is already queued.");
  return out;
}

async function pendingDeleteIds(database: DbLike): Promise<Set<string>> {
  const rows = await database
    .select({ imageRowId: sql<string>`${jobs.payload}->>'imageRowId'` })
    .from(jobs)
    .where(and(eq(jobs.type, "delete_image"), inArray(jobs.status, ["queued", "running"])));
  return new Set(rows.map((r) => r.imageRowId));
}

export async function loadImageOverview(
  database: DbLike,
  limit = 50,
): Promise<{ rows: ImageOverviewRow[]; live: WorkspaceImageRef[] }> {
  const [imgs, live, pending, failedDeletes] = await Promise.all([
    database.select().from(images).orderBy(desc(images.createdAt)).limit(limit),
    listLiveWorkspaceImages(database),
    pendingDeleteIds(database),
    database
      .select({
        imageRowId: sql<string>`${jobs.payload}->>'imageRowId'`,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(eq(jobs.type, "delete_image"), eq(jobs.status, "failed")))
      .orderBy(desc(jobs.createdAt))
      .limit(200),
  ]);
  const lastError = new Map<string, string | null>();
  for (const f of failedDeletes)
    if (!lastError.has(f.imageRowId)) lastError.set(f.imageRowId, f.lastError);
  const gateWorkspaces = imgs.some((i) => parseImageManifest(i.manifest))
    ? await loadGateWorkspaces(database)
    : [];
  const rows = imgs.map((image) => {
    const usage = usageOf(image, live);
    const deleteQueued = pending.has(image.id);
    return {
      image,
      gate: gateFailures(image, gateWorkspaces),
      usage,
      deleteQueued,
      lastDeleteError: deleteQueued ? null : (lastError.get(image.id) ?? null),
    };
  });
  return { rows, live };
}

async function loadImage(tx: DbLike, id: string, lock = true): Promise<ImageRow> {
  const q = tx.select().from(images).where(eq(images.id, id));
  const row = (await (lock ? q.for("update") : q))[0];
  if (!row) throw new UserError("Image not found");
  return row;
}

async function hasPendingDelete(tx: DbLike, imageRowId: string): Promise<boolean> {
  return (await pendingDeleteIds(tx)).has(imageRowId);
}

/** Throws unless a workspace may start from this image. */
async function assertUsable(tx: DbLike, image: ImageRow): Promise<void> {
  if (!isImageUsable(image)) {
    throw new UserError(`Image ${image.t3Ref} cannot be used (${image.status})`);
  }
  if (await hasPendingDelete(tx, image.id)) {
    throw new UserError(`Image ${image.t3Ref} is being deleted`);
  }
}

async function enqueueImageRestart(
  tx: DbLike,
  actor: ImageActor,
  ws: Pick<WorkspaceRow, "id" | "slug">,
  reason: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(jobs)
    .values({ type: "restart_workspace", workspaceId: ws.id, payload: {} })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  if (!inserted[0]) return false;
  await writeAudit(tx, {
    actorId: actor.adminId,
    action: "workspace.restart",
    targetType: "workspace",
    targetId: ws.id,
    metadata: { slug: ws.slug, reason },
    ip: actor.ip,
  });
  return true;
}

async function loadLiveWorkspaceBySlug(tx: DbLike, slug: string): Promise<WorkspaceRow> {
  const ws = (
    await tx.select().from(workspaces).where(eq(workspaces.slug, slug)).for("update").limit(1)
  )[0];
  if (!ws) throw new UserError("Workspace not found");
  if ((goneStatuses as string[]).includes(ws.status) || ws.status === "provisioning") {
    throw new UserError(`Cannot change the image of a workspace that is ${ws.status}`);
  }
  return ws;
}

export interface ActivateInput {
  imageRowId: string;
  overrideReason: string | null;
  moveMode: MoveMode;
}

export interface ActivateResult {
  restarted: string[];
  unpinned: string[];
}

/** Makes a usable image the single active one; optionally moves workspaces onto it. */
export async function activateImageWithMove(
  database: Db,
  actor: ImageActor,
  input: ActivateInput,
): Promise<ActivateResult> {
  return database.transaction(async (tx) => {
    const row = await loadImage(tx, input.imageRowId);
    if (row.status === "active") throw new UserError("That image is already active");
    if (!isImageUsable(row)) {
      throw new UserError(
        "Only a ready image (or a retired one whose files remain) can be activated",
      );
    }
    if (await hasPendingDelete(tx, row.id)) throw new UserError("That image is being deleted");
    const { overrideReason } = activationOverride(row.scanSummary, input.overrideReason);
    // Followers pick the active image up on their next start whatever the move mode; pinned
    // workspaces only join them when moveMode "all" unpins them.
    const affected = await tx
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(
        and(
          notInArray(workspaces.status, goneStatuses),
          input.moveMode === "all" ? undefined : isNull(workspaces.pinnedImageId),
        ),
      );
    assertGate(
      row,
      await evaluateWorkspaceGates(
        tx,
        row,
        affected.map((w) => w.slug),
      ),
      "activate",
    );
    await tx.update(images).set({ status: "ready" }).where(eq(images.status, "active"));
    await tx.update(images).set({ status: "active", overrideReason }).where(eq(images.id, row.id));

    const restarted: string[] = [];
    const unpinned: string[] = [];
    if (input.moveMode !== "none") {
      const live = await tx
        .select()
        .from(workspaces)
        .where(notInArray(workspaces.status, goneStatuses))
        .for("update");
      for (const ws of live) {
        if (ws.pinnedImageId !== null) {
          if (input.moveMode !== "all") continue;
          await tx.update(workspaces).set({ pinnedImageId: null }).where(eq(workspaces.id, ws.id));
          unpinned.push(ws.slug);
        }
        if (ws.status === "running" && ws.imageId !== row.imageId) {
          if (await enqueueImageRestart(tx, actor, ws, "image.activate")) restarted.push(ws.slug);
        }
      }
    }
    await writeAudit(tx, {
      actorId: actor.adminId,
      action: "image.activate",
      targetType: "image",
      targetId: row.id,
      metadata: {
        imageId: row.imageId,
        overrideReason,
        moveMode: input.moveMode,
        restarted,
        unpinned,
      },
      ip: actor.ip,
    });
    return { restarted, unpinned };
  });
}

/**
 * Pin a workspace to an image, or (null) make it follow the active image. A running workspace
 * restarts when the resulting image differs from the one it runs; a sleeping one picks it up on
 * its next wake.
 */
export async function setWorkspaceImage(
  database: Db,
  actor: ImageActor,
  slug: string,
  imageRowId: string | null,
): Promise<{ restarted: boolean }> {
  return database.transaction(async (tx) => {
    const ws = await loadLiveWorkspaceBySlug(tx, slug);
    let target: ImageRow | undefined;
    if (imageRowId) {
      target = await loadImage(tx, imageRowId);
      await assertUsable(tx, target);
    } else {
      target = (await tx.select().from(images).where(eq(images.status, "active")).limit(1))[0];
    }
    if (target) {
      assertGate(
        target,
        await evaluateWorkspaceGates(tx, target, [ws.slug]),
        imageRowId ? "pin to" : "follow",
      );
    }
    await tx.update(workspaces).set({ pinnedImageId: imageRowId }).where(eq(workspaces.id, ws.id));
    const restart =
      ws.status === "running" && target?.imageId != null && ws.imageId !== target.imageId;
    const restarted = restart
      ? await enqueueImageRestart(tx, actor, ws, imageRowId ? "image.pin" : "image.follow_active")
      : false;
    await writeAudit(tx, {
      actorId: actor.adminId,
      action: imageRowId ? "workspace.image_pin" : "workspace.image_follow_active",
      targetType: "workspace",
      targetId: ws.id,
      metadata: {
        slug: ws.slug,
        imageRowId,
        imageId: target?.imageId ?? null,
        previousPinnedImageRowId: ws.pinnedImageId,
        previousImageId: ws.imageId,
        restarted,
      },
      ip: actor.ip,
    });
    return { restarted };
  });
}

export interface BulkMoveInput {
  imageRowId: string;
  slugs: string[];
  /** `pin`: pin each workspace to the image. `follow`: clear pins (image must be the active one). */
  mode: "pin" | "follow";
}

/** Moves many workspaces onto one image in a single transaction; restarts only running ones. */
export async function bulkMoveWorkspaces(
  database: Db,
  actor: ImageActor,
  input: BulkMoveInput,
): Promise<{ moved: string[]; restarted: string[] }> {
  if (input.slugs.length === 0) throw new UserError("Select at least one workspace");
  return database.transaction(async (tx) => {
    const image = await loadImage(tx, input.imageRowId);
    await assertUsable(tx, image);
    if (input.mode === "follow" && image.status !== "active") {
      throw new UserError("Only the active image can be followed; pin the workspaces instead");
    }
    const slugs = [...new Set(input.slugs)];
    const rows = await tx
      .select()
      .from(workspaces)
      .where(inArray(workspaces.slug, slugs))
      .for("update");
    if (rows.length !== slugs.length) throw new UserError("A selected workspace no longer exists");
    assertGate(
      image,
      await evaluateWorkspaceGates(tx, image, slugs),
      input.mode === "pin" ? "pin to" : "follow",
    );
    const bad = rows.find(
      (w) => (goneStatuses as string[]).includes(w.status) || w.status === "provisioning",
    );
    if (bad) throw new UserError(`${bad.slug} is ${bad.status}; its image cannot be changed`);
    const moved: string[] = [];
    const restarted: string[] = [];
    for (const ws of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
      await tx
        .update(workspaces)
        .set({ pinnedImageId: input.mode === "pin" ? image.id : null })
        .where(eq(workspaces.id, ws.id));
      moved.push(ws.slug);
      let didRestart = false;
      if (ws.status === "running" && ws.imageId !== image.imageId) {
        didRestart = await enqueueImageRestart(tx, actor, ws, "image.bulk_move");
        if (didRestart) restarted.push(ws.slug);
      }
      await writeAudit(tx, {
        actorId: actor.adminId,
        action: input.mode === "pin" ? "workspace.image_pin" : "workspace.image_follow_active",
        targetType: "workspace",
        targetId: ws.id,
        metadata: {
          slug: ws.slug,
          imageRowId: image.id,
          imageId: image.imageId,
          previousPinnedImageRowId: ws.pinnedImageId,
          previousImageId: ws.imageId,
          restarted: didRestart,
          bulk: true,
        },
        ip: actor.ip,
      });
    }
    return { moved, restarted };
  });
}

/**
 * Delete an image's files. Refused while it is active, pinned, or used by a container that is up.
 * Rows that never produced files (failed, stale `building`, already-deleted `retired`) are simply
 * removed; everything else enqueues `delete_image`, which the worker re-checks before touching
 * the host and finishes by marking the row `retired` with no rootfs.
 */
export async function requestImageDelete(
  database: Db,
  actor: ImageActor,
  imageRowId: string,
): Promise<{ queued: boolean }> {
  return database.transaction(async (tx) => {
    const row = await loadImage(tx, imageRowId);
    const live = await listLiveWorkspaceImages(tx);
    const usage = usageOf(row, live);
    const pending = await hasPendingDelete(tx, row.id);

    let staleBuild = false;
    if (row.status === "building") {
      const active = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "build_image"),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'imageRowId' = ${row.id}`,
          ),
        )
        .limit(1);
      staleBuild = active.length === 0;
    }
    const blockers = blockersOf(row, usage, pending).filter(
      (b) => !(staleBuild && b === "A build is running."),
    );
    if (blockers.length > 0) throw new UserError(`Cannot delete this image. ${blockers.join(" ")}`);

    const noFiles =
      staleBuild ||
      (row.status === "failed" && !row.imageId) ||
      (row.status === "retired" && !row.rootfsPath);
    if (noFiles) {
      // Deleted workspaces may still reference it; live ones were rejected above.
      await tx
        .update(workspaces)
        .set({ pinnedImageId: null })
        .where(eq(workspaces.pinnedImageId, row.id));
      await tx.delete(images).where(eq(images.id, row.id));
    } else {
      await tx
        .insert(jobs)
        .values({ type: "delete_image", workspaceId: null, payload: { imageRowId: row.id } });
    }
    await writeAudit(tx, {
      actorId: actor.adminId,
      action: "image.delete",
      targetType: "image",
      targetId: row.id,
      metadata: {
        imageId: row.imageId,
        t3Ref: row.t3Ref,
        status: row.status,
        removedRow: noFiles,
      },
      ip: actor.ip,
    });
    return { queued: !noFiles };
  });
}

/** Enqueue a toolchain reconcile for each live workspace in `slugs` (admin "Reconcile now"). */
export async function requestWorkspaceReconciles(
  database: Db,
  actor: ImageActor,
  slugs: string[],
): Promise<{ queued: string[] }> {
  if (slugs.length === 0) throw new UserError("Select at least one workspace");
  const rows = await database
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(and(inArray(workspaces.slug, slugs), notInArray(workspaces.status, goneStatuses)));
  const queued: string[] = [];
  for (const ws of rows) {
    await requestReconcile(database, { workspaceId: ws.id, trigger: "admin" });
    await writeAudit(database, {
      actorId: actor.adminId,
      action: "toolchain.reconcile",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { slug: ws.slug, trigger: "admin" },
      ip: actor.ip,
    });
    queued.push(ws.slug);
  }
  return { queued };
}
