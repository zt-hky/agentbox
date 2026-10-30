"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { wsSlugSchema } from "@agentbox/core/agent-api";
import { images, jobs } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import {
  activateImageWithMove,
  bulkMoveWorkspaces,
  requestImageDelete,
  requestWorkspaceReconciles,
  type MoveMode,
} from "@/lib/admin/images-ops";
import { tailLog } from "@/lib/images";
import { t3RefSchema } from "@/lib/schemas";

const idSchema = z.uuid();

export async function buildImage(t3Ref: string, slim = false) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = t3RefSchema.safeParse(t3Ref);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid ref");
    const isSlim = z.boolean().parse(slim);
    await db.transaction(async (tx) => {
      const building = await tx
        .select({ id: images.id })
        .from(images)
        .where(eq(images.status, "building"))
        .limit(1);
      if (building.length > 0) throw new UserError("An image build is already running");
      const inserted = await tx
        .insert(images)
        .values({ t3Ref: parsed.data, status: "building", createdBy: admin.id })
        .returning({ id: images.id });
      const imageRowId = inserted[0]!.id;
      await tx
        .insert(jobs)
        .values({
          type: "build_image",
          workspaceId: null,
          payload: { imageRowId, t3Ref: parsed.data, ...(isSlim ? { slim: true } : {}) },
        })
        .onConflictDoNothing();
      await writeAudit(tx, {
        actorId: admin.id,
        action: "image.build",
        targetType: "image",
        targetId: imageRowId,
        metadata: { t3Ref: parsed.data, slim: isSlim },
        ip,
      });
    });
    revalidatePath("/admin/images");
  });
}

/** Polled every 3 s by the client while a build is running. */
export async function pollImage(imageRowId: string) {
  return guard(async () => {
    await adminContext();
    const row = (
      await db
        .select()
        .from(images)
        .where(eq(images.id, idSchema.parse(imageRowId)))
        .limit(1)
    )[0];
    if (!row) throw new UserError("Image not found");
    return { status: row.status, buildLog: tailLog(row.buildLog) };
  });
}

export async function activateImage(
  imageRowId: string,
  overrideReason: string | null,
  moveMode: MoveMode = "none",
) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const result = await activateImageWithMove(
      db,
      { adminId: admin.id, ip },
      {
        imageRowId: idSchema.parse(imageRowId),
        overrideReason,
        moveMode: z.enum(["none", "running", "all"]).parse(moveMode),
      },
    );
    revalidatePath("/admin/images");
    revalidatePath("/admin/workspaces");
    return result;
  });
}

export async function retireImage(imageRowId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const row = (
        await tx
          .select()
          .from(images)
          .where(eq(images.id, idSchema.parse(imageRowId)))
          .for("update")
      )[0];
      if (!row) throw new UserError("Image not found");
      if (row.status !== "ready") throw new UserError("Only a ready image can be retired");
      await tx.update(images).set({ status: "retired" }).where(eq(images.id, row.id));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "image.retire",
        targetType: "image",
        targetId: row.id,
        metadata: { imageId: row.imageId },
        ip,
      });
    });
    revalidatePath("/admin/images");
  });
}

/** Delete an image's files (or the row, when it never had any); see `requestImageDelete`. */
export async function deleteImage(imageRowId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const result = await requestImageDelete(
      db,
      { adminId: admin.id, ip },
      idSchema.parse(imageRowId),
    );
    revalidatePath("/admin/images");
    return result;
  });
}

/** Pin many workspaces to one image (or have them follow the active one) in one transaction. */
export async function moveWorkspacesToImage(
  imageRowId: string,
  slugs: string[],
  mode: "pin" | "follow",
) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const input = z
      .object({
        imageRowId: z.uuid(),
        slugs: z.array(wsSlugSchema).max(500),
        mode: z.enum(["pin", "follow"]),
      })
      .parse({ imageRowId, slugs, mode });
    const result = await bulkMoveWorkspaces(db, { adminId: admin.id, ip }, input);
    revalidatePath("/admin/images");
    revalidatePath("/admin/workspaces");
    return result;
  });
}

/** "Reconcile now": enqueue a toolchain reconcile for workspaces an image gate rejects. */
export async function reconcileWorkspaces(slugs: string[]) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = z.array(wsSlugSchema).min(1).max(500).parse(slugs);
    const result = await requestWorkspaceReconciles(db, { adminId: admin.id, ip }, [
      ...new Set(parsed),
    ]);
    revalidatePath("/admin/images");
    return result;
  });
}
