import { and, eq, inArray, sql } from "drizzle-orm";
import { encrypt, randomToken } from "@agentbox/core/tokens";
import { CATALOG, type ToolDefault } from "@agentbox/core/toolchain";
import { loadToolchainSettings, requestReconcile } from "@agentbox/db/toolchain";
import {
  githubConnections,
  subscriptions,
  user,
  workspaceTools,
  workspaces,
  workspaceSessions,
} from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { Db, DbLike } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";
import { resolveSelection, type ChosenVersions } from "./onboarding-selection";
import { checkSlugAvailable } from "./slug-taken";
import { assertCanApplyToolchain, TOOLCHAIN_WORKSPACE_STATUSES } from "./toolchain/gate";
import { defaultFor } from "./toolchain/view";

export interface CreateWorkspaceInput {
  userId: string;
  encryptionKey: string;
  ip?: string | null;
  now?: Date;
}

export interface CreateWorkspaceResult {
  workspaceId: string;
  slug: string;
  /** `provisioned`: a tenant is being (re)created; `applied`: the selection went to an existing workspace; `inflight`: nothing to do, creation is already underway. */
  outcome: "provisioned" | "applied" | "inflight";
}

/**
 * Write the user's tool selection as desired state: selected tools become `desired` (new rows
 * start `pending` on the version the user chose, else the admin default channel; existing rows
 * keep their channel and version), and unselected tools that have a row stop being desired.
 */
export async function applySelectionRows(
  database: DbLike,
  workspaceId: string,
  selected: ReadonlySet<string>,
  defaults: readonly ToolDefault[],
  disabled: ReadonlySet<string>,
  versions: ChosenVersions = {},
): Promise<void> {
  const existing = await database
    .select({ toolId: workspaceTools.toolId })
    .from(workspaceTools)
    .where(eq(workspaceTools.workspaceId, workspaceId));
  const have = new Set(existing.map((r) => r.toolId));
  const fresh = CATALOG.filter((e) => selected.has(e.id) && !have.has(e.id) && !disabled.has(e.id));
  if (fresh.length > 0) {
    await database.insert(workspaceTools).values(
      fresh.map((e) => {
        const d = versions[e.id] ?? defaultFor(defaults, e);
        return {
          workspaceId,
          toolId: e.id,
          channel: d.channel,
          pinnedVersion: d.pinnedVersion,
          desired: true,
          source: "user" as const,
          state: "pending" as const,
        };
      }),
    );
  }
  const keep = [...selected];
  if (keep.length > 0) {
    await database
      .update(workspaceTools)
      .set({ desired: true, source: "user", updatedAt: new Date() })
      .where(and(eq(workspaceTools.workspaceId, workspaceId), inArray(workspaceTools.toolId, keep)));
  }
  const drop = existing.map((r) => r.toolId).filter((id) => !selected.has(id));
  if (drop.length > 0) {
    await database
      .update(workspaceTools)
      .set({ desired: false, source: "user", updatedAt: new Date() })
      .where(and(eq(workspaceTools.workspaceId, workspaceId), inArray(workspaceTools.toolId, drop)));
  }
}

/**
 * Onboarding step 4. Creates the user's workspace (or re-creates a `deleted` one, reusing its row
 * and, when its data was kept, its slug and slot so the old home directory is adopted) and applies
 * the saved tool selection. The tenant is provisioned and started by the worker, which then
 * installs the tools. A user who already has a live workspace gets the selection applied to it.
 * Safe to call again while creation is underway.
 */
export async function createWorkspaceForUser(
  database: Db,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  const now = input.now ?? new Date();
  const result = await database.transaction(async (tx): Promise<CreateWorkspaceResult> => {
    const target = (await tx.select().from(user).where(eq(user.id, input.userId)).for("update"))[0];
    if (!target) throw new UserError("User not found");
    if (target.accessStatus !== "active") throw new UserError("Your account is not active");

    const settings = await loadToolchainSettings(tx);
    const selection = await resolveSelection(tx, target.id);
    const selected = new Set<string>([
      ...selection.tools,
      ...selection.packageManagers,
      ...selection.agents,
    ]);
    const disabled = new Set<string>(settings.disabled);

    const old = (
      await tx.select().from(workspaces).where(eq(workspaces.userId, target.id)).for("update")
    )[0];

    if (old && old.status === "deleting") {
      throw new UserError("Your previous workspace is still being deleted. Try again in a moment.");
    }

    if (old && old.status !== "deleted") {
      if (!(TOOLCHAIN_WORKSPACE_STATUSES as readonly string[]).includes(old.status)) {
        return { workspaceId: old.id, slug: old.slug, outcome: "inflight" };
      }
      await assertCanApplyToolchain(tx, { userId: target.id, workspaceStatus: old.status, now });
      await applySelectionRows(tx, old.id, selected, settings.defaults, disabled, selection.versions);
      return { workspaceId: old.id, slug: old.slug, outcome: "applied" };
    }

    const sub = (
      await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.userId, target.id))
        .limit(1)
    )[0];
    if (!sub) throw new UserError("Your account has no plan yet. Ask an administrator.");

    const keepSlot = old?.dataKept === true;
    const slug = keepSlot ? old.slug : (target.reservedSlug ?? old?.slug ?? null);
    if (!slug) throw new UserError("No workspace name is reserved for your account yet.");
    const slugCheck = await checkSlugAvailable(tx, slug, target.id);
    if (!slugCheck.ok) throw new UserError(slugCheck.error);

    let slot: number;
    if (keepSlot) {
      slot = old.slot;
    } else {
      const slotRes = await tx.execute<{ slot: number }>(
        sql`select nextval('tenant_slot_seq')::int as slot`,
      );
      const next = slotRes.rows[0]?.slot;
      if (typeof next !== "number") throw new UserError("No tenant slot available");
      slot = next;
    }

    const [gh] = await tx
      .select({ id: githubConnections.id })
      .from(githubConnections)
      .where(eq(githubConnections.userId, target.id))
      .limit(1);

    const fresh = {
      slug,
      slot,
      status: "provisioning" as const,
      imageId: null,
      identitySecretEnc: encrypt(randomToken(), input.encryptionKey),
      lastRequestAt: null,
      lastActivityAt: null,
      awakeSince: null,
      lastCpuUsec: 0n,
      startFailures: 0,
      // A GitHub account connected during onboarding is pushed into the workspace on its first start.
      githubSyncPending: !!gh,
      dataKept: false,
      toolchainGeneration: 0,
      toolchainAppliedGeneration: 0,
      // The worker starts the workspace right after provisioning and installs the tools then.
      toolchainPending: true,
      toolchainAbi: null,
      toolchainReconciledAt: null,
      createdAt: now,
    };
    let workspaceId: string;
    if (old) {
      workspaceId = old.id;
      await tx.delete(workspaceTools).where(eq(workspaceTools.workspaceId, old.id));
      await tx.update(workspaces).set(fresh).where(eq(workspaces.id, old.id));
    } else {
      const [inserted] = await tx
        .insert(workspaces)
        .values({ userId: target.id, ...fresh })
        .returning({ id: workspaces.id });
      workspaceId = inserted!.id;
    }
    await tx.update(user).set({ reservedSlug: slug }).where(eq(user.id, target.id));
    await tx
      .update(workspaceSessions)
      .set({ revokedAt: now })
      .where(eq(workspaceSessions.workspaceId, workspaceId));
    await applySelectionRows(
      tx,
      workspaceId,
      selected,
      settings.defaults,
      disabled,
      selection.versions,
    );
    await enqueueWorkspaceJob(tx, workspaceId, { type: "provision_tenant" });
    await writeAudit(tx, {
      actorId: target.id,
      action: old ? "workspace.recreate" : "workspace.create",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { slug, slot, reusedData: keepSlot, tools: [...selected] },
      ip: input.ip ?? null,
    });
    return { workspaceId, slug, outcome: "provisioned" };
  });

  if (result.outcome === "applied") {
    await requestReconcile(database, { workspaceId: result.workspaceId, trigger: "user" });
  }
  return result;
}
