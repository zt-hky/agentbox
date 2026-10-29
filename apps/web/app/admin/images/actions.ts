"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { images, jobs } from "@agentbox/db/schema";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { writeAudit } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { activationOverride, tailLog } from "@/lib/images";
import { t3RefSchema } from "@/lib/schemas";

const idSchema = z.uuid();

export async function buildImage(t3Ref: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    const parsed = t3RefSchema.safeParse(t3Ref);
    if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Invalid ref");
    await db.transaction(async (tx) => {
      const building = await tx.select({ id: images.id }).from(images).where(eq(images.status, "building")).limit(1);
      if (building.length > 0) throw new UserError("An image build is already running");
      const inserted = await tx
        .insert(images)
        .values({ t3Ref: parsed.data, status: "building", createdBy: admin.id })
        .returning({ id: images.id });
      const imageRowId = inserted[0]!.id;
      await tx
        .insert(jobs)
        .values({ type: "build_image", workspaceId: null, payload: { imageRowId, t3Ref: parsed.data } })
        .onConflictDoNothing();
      await writeAudit(tx, {
        actorId: admin.id,
        action: "image.build",
        targetType: "image",
        targetId: imageRowId,
        metadata: { t3Ref: parsed.data },
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
    const row = (await db.select().from(images).where(eq(images.id, idSchema.parse(imageRowId))).limit(1))[0];
    if (!row) throw new UserError("Image not found");
    return { status: row.status, buildLog: tailLog(row.buildLog) };
  });
}

export async function activateImage(imageRowId: string, overrideReason: string | null) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const row = (
        await tx.select().from(images).where(eq(images.id, idSchema.parse(imageRowId))).for("update")
      )[0];
      if (!row) throw new UserError("Image not found");
      if (row.status !== "ready" || !row.imageId) throw new UserError("Only a ready image can be activated");
      const { overrideReason: stored } = activationOverride(row.scanSummary, overrideReason);
      await tx.update(images).set({ status: "ready" }).where(eq(images.status, "active"));
      await tx.update(images).set({ status: "active", overrideReason: stored }).where(eq(images.id, row.id));
      await writeAudit(tx, {
        actorId: admin.id,
        action: "image.activate",
        targetType: "image",
        targetId: row.id,
        metadata: { imageId: row.imageId, overrideReason: stored },
        ip,
      });
    });
    revalidatePath("/admin/images");
  });
}

export async function retireImage(imageRowId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const row = (
        await tx.select().from(images).where(eq(images.id, idSchema.parse(imageRowId))).for("update")
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

/**
 * Delete an image's rootfs. Ready/retired rows enqueue `delete_image` (the worker marks the row
 * retired). Failed rows never produced a rootfs, so the row itself is removed.
 */
export async function deleteImage(imageRowId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await db.transaction(async (tx) => {
      const id = idSchema.parse(imageRowId);
      const row = (await tx.select().from(images).where(eq(images.id, id)).for("update"))[0];
      if (!row) throw new UserError("Image not found");
      if (row.status === "active") throw new UserError("Activate another image before deleting the active one");
      if (row.status === "building") throw new UserError("A build is still running");
      if (row.status === "failed" && !row.imageId) {
        await tx.delete(images).where(eq(images.id, row.id));
      } else {
        const queued = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.type, "delete_image"),
              inArray(jobs.status, ["queued", "running"]),
              sql`${jobs.payload}->>'imageRowId' = ${row.id}`,
            ),
          )
          .limit(1);
        if (queued.length > 0) throw new UserError("Deletion is already queued");
        await tx.insert(jobs).values({ type: "delete_image", workspaceId: null, payload: { imageRowId: row.id } });
      }
      await writeAudit(tx, {
        actorId: admin.id,
        action: "image.delete",
        targetType: "image",
        targetId: row.id,
        metadata: { imageId: row.imageId, status: row.status },
        ip,
      });
    });
    revalidatePath("/admin/images");
  });
}
