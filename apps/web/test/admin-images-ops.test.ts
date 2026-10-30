import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, images, jobs, workspaces } from "@agentbox/db/schema";
import {
  activateImageWithMove,
  bulkMoveWorkspaces,
  requestImageDelete,
  setWorkspaceImage,
} from "../lib/admin/images-ops";
import { UserError } from "../lib/errors";
import { createTestDb, seedAdmin, seedUser, type TestDb } from "./helpers/db";

let t: TestDb;
let adminId: string;
let n = 0;
const actor = () => ({ adminId, ip: "198.51.100.9" });
const A = "a".repeat(64);
const B = "b".repeat(64);
const scan = {
  counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
  fixableCritical: 0,
};

beforeAll(async () => {
  t = await createTestDb();
  adminId = await seedAdmin(t.db);
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(jobs);
  await t.db.delete(workspaces);
  await t.db.delete(images);
});

async function seedImage(
  status: (typeof images.$inferInsert)["status"],
  imageId: string | null,
  extra = {},
) {
  const [row] = await t.db
    .insert(images)
    .values({
      imageId,
      rootfsPath: imageId ? `/r/${imageId}` : null,
      t3Ref: `ref-${imageId?.slice(0, 2) ?? "none"}`,
      status,
      scanSummary: scan,
      ...extra,
    })
    .returning();
  return row!;
}
async function seedWs(
  status: (typeof workspaces.$inferInsert)["status"],
  extra: Partial<typeof workspaces.$inferInsert> = {},
) {
  n++;
  const userId = await seedUser(t.db, `img${n}@example.com`, "active");
  const [ws] = await t.db
    .insert(workspaces)
    .values({ userId, slug: `img${n}x`, slot: 200 + n, status, identitySecretEnc: "x", ...extra })
    .returning();
  return ws!;
}
const restarts = async () =>
  (await t.db.select().from(jobs)).filter((j) => j.type === "restart_workspace");
const wsRow = async (id: string) =>
  (await t.db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(UserError);
  expect((e as Error).message).toMatch(re);
};

describe("setWorkspaceImage", () => {
  it("pins a running workspace and restarts it onto the image", async () => {
    await seedImage("active", A);
    const old = await seedImage("ready", B);
    const ws = await seedWs("running", { imageId: A });
    expect(await setWorkspaceImage(t.db, actor(), ws.slug, old.id)).toEqual({ restarted: true });
    expect((await wsRow(ws.id)).pinnedImageId).toBe(old.id);
    expect(await restarts()).toHaveLength(1);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "workspace.image_pin"));
    expect(audits).toHaveLength(1);
  });

  it("does not restart a sleeping workspace, or one already on the image", async () => {
    const act = await seedImage("active", A);
    const other = await seedImage("ready", B);
    const sleeping = await seedWs("sleeping", { imageId: A });
    expect((await setWorkspaceImage(t.db, actor(), sleeping.slug, other.id)).restarted).toBe(false);
    const same = await seedWs("running", { imageId: A });
    expect((await setWorkspaceImage(t.db, actor(), same.slug, act.id)).restarted).toBe(false);
    expect(await restarts()).toHaveLength(0);
  });

  it("follow-active clears the pin and restarts a running workspace on another image", async () => {
    const act = await seedImage("active", A);
    const old = await seedImage("ready", B);
    const ws = await seedWs("running", { imageId: B, pinnedImageId: old.id });
    expect((await setWorkspaceImage(t.db, actor(), ws.slug, null)).restarted).toBe(true);
    expect((await wsRow(ws.id)).pinnedImageId).toBeNull();
    expect(act.imageId).toBe(A);
  });

  it("refuses failed, building and deleting-image targets and gone workspaces", async () => {
    const failed = await seedImage("failed", null);
    const ws = await seedWs("sleeping");
    await rejects(setWorkspaceImage(t.db, actor(), ws.slug, failed.id), /cannot be used/);
    const ready = await seedImage("ready", B);
    await t.db.insert(jobs).values({ type: "delete_image", payload: { imageRowId: ready.id } });
    await rejects(setWorkspaceImage(t.db, actor(), ws.slug, ready.id), /being deleted/);
    const gone = await seedWs("deleted");
    const ok = await seedImage("ready", A);
    await rejects(setWorkspaceImage(t.db, actor(), gone.slug, ok.id), /deleted/);
  });
});

describe("bulkMoveWorkspaces", () => {
  it("pins all selected and restarts only running ones on another image", async () => {
    await seedImage("active", A);
    const target = await seedImage("ready", B);
    const run = await seedWs("running", { imageId: A });
    const runSame = await seedWs("running", { imageId: B });
    const sleep = await seedWs("sleeping", { imageId: A });
    const res = await bulkMoveWorkspaces(t.db, actor(), {
      imageRowId: target.id,
      slugs: [run.slug, runSame.slug, sleep.slug],
      mode: "pin",
    });
    expect(res.moved).toHaveLength(3);
    expect(res.restarted).toEqual([run.slug]);
    expect((await restarts()).map((j) => j.workspaceId)).toEqual([run.id]);
    expect((await wsRow(sleep.id)).pinnedImageId).toBe(target.id);
  });

  it("follow mode needs the active image and clears pins; unknown slug is refused", async () => {
    const act = await seedImage("active", A);
    const other = await seedImage("ready", B);
    const ws = await seedWs("sleeping", { pinnedImageId: other.id });
    await rejects(
      bulkMoveWorkspaces(t.db, actor(), { imageRowId: other.id, slugs: [ws.slug], mode: "follow" }),
      /active image/,
    );
    await bulkMoveWorkspaces(t.db, actor(), {
      imageRowId: act.id,
      slugs: [ws.slug],
      mode: "follow",
    });
    expect((await wsRow(ws.id)).pinnedImageId).toBeNull();
    await rejects(
      bulkMoveWorkspaces(t.db, actor(), { imageRowId: act.id, slugs: ["nope1"], mode: "follow" }),
      /no longer exists/,
    );
  });
});

describe("activateImageWithMove", () => {
  it("none: switches active only", async () => {
    const old = await seedImage("active", A);
    const next = await seedImage("ready", B);
    const ws = await seedWs("running", { imageId: A });
    await activateImageWithMove(t.db, actor(), {
      imageRowId: next.id,
      overrideReason: null,
      moveMode: "none",
    });
    expect((await t.db.select().from(images).where(eq(images.id, old.id)))[0]!.status).toBe(
      "ready",
    );
    expect((await t.db.select().from(images).where(eq(images.id, next.id)))[0]!.status).toBe(
      "active",
    );
    expect(await restarts()).toHaveLength(0);
    expect(ws.status).toBe("running");
  });

  it("running: restarts followers only, leaving pinned and sleeping workspaces", async () => {
    await seedImage("active", A);
    const next = await seedImage("ready", B);
    const pin = await seedImage("ready", "c".repeat(64));
    const follower = await seedWs("running", { imageId: A });
    await seedWs("running", { imageId: "c".repeat(64), pinnedImageId: pin.id });
    await seedWs("sleeping", { imageId: A });
    const res = await activateImageWithMove(t.db, actor(), {
      imageRowId: next.id,
      overrideReason: null,
      moveMode: "running",
    });
    expect(res).toEqual({ restarted: [follower.slug], unpinned: [] });
    expect((await restarts()).map((j) => j.workspaceId)).toEqual([follower.id]);
  });

  it("all: unpins and restarts running workspaces on other images", async () => {
    await seedImage("active", A);
    const next = await seedImage("ready", B);
    const pin = await seedImage("ready", "c".repeat(64));
    const pinned = await seedWs("running", { imageId: "c".repeat(64), pinnedImageId: pin.id });
    const res = await activateImageWithMove(t.db, actor(), {
      imageRowId: next.id,
      overrideReason: null,
      moveMode: "all",
    });
    expect(res).toEqual({ restarted: [pinned.slug], unpinned: [pinned.slug] });
    expect((await wsRow(pinned.id)).pinnedImageId).toBeNull();
  });

  it("refuses non-usable and already-active images", async () => {
    const act = await seedImage("active", A);
    const failed = await seedImage("failed", null);
    await rejects(
      activateImageWithMove(t.db, actor(), {
        imageRowId: act.id,
        overrideReason: null,
        moveMode: "none",
      }),
      /already active/,
    );
    await rejects(
      activateImageWithMove(t.db, actor(), {
        imageRowId: failed.id,
        overrideReason: null,
        moveMode: "none",
      }),
      /ready image/,
    );
  });
});

describe("requestImageDelete", () => {
  it("refuses the active image, pinned images and images a running workspace uses", async () => {
    const act = await seedImage("active", A);
    await rejects(requestImageDelete(t.db, actor(), act.id), /active image/);
    const pinImg = await seedImage("ready", B);
    const pinner = await seedWs("sleeping", { pinnedImageId: pinImg.id });
    await rejects(
      requestImageDelete(t.db, actor(), pinImg.id),
      new RegExp(`Pinned by.*${pinner.slug}`),
    );
    const used = await seedImage("ready", "d".repeat(64));
    const runner = await seedWs("running", { imageId: "d".repeat(64) });
    await rejects(
      requestImageDelete(t.db, actor(), used.id),
      new RegExp(`Running.*${runner.slug}`),
    );
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it("enqueues delete_image for a ready image only sleeping workspaces last used, once", async () => {
    await seedImage("active", A);
    const old = await seedImage("ready", B);
    await seedWs("sleeping", { imageId: B });
    expect(await requestImageDelete(t.db, actor(), old.id)).toEqual({ queued: true });
    const q = (await t.db.select().from(jobs)).filter((j) => j.type === "delete_image");
    expect(q).toHaveLength(1);
    expect(q[0]!.payload).toEqual({ imageRowId: old.id });
    await rejects(requestImageDelete(t.db, actor(), old.id), /already queued/);
  });

  it("removes rows that have no files: failed, stale building, retired without rootfs", async () => {
    const failed = await seedImage("failed", null);
    const stale = await seedImage("building", null);
    const gone = await seedImage("retired", B, { rootfsPath: null });
    for (const r of [failed, stale, gone]) {
      expect(await requestImageDelete(t.db, actor(), r.id)).toEqual({ queued: false });
    }
    expect(await t.db.select().from(images)).toHaveLength(0);
  });

  it("refuses a building image with a live build job", async () => {
    const b = await seedImage("building", null);
    await t.db
      .insert(jobs)
      .values({ type: "build_image", payload: { imageRowId: b.id, t3Ref: "x" } });
    await rejects(requestImageDelete(t.db, actor(), b.id), /build is running/);
  });
});
