import { and, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { agentKeys, auditLog, jobs, user, workspaceSessions, workspaces } from "./schema.ts";

export interface ResetWorkspacesOptions {
  /** Keep every tenant home (configs, repos) on the host so re-creation adopts it. */
  keepData: boolean;
  /** Report what would change without writing anything. */
  dryRun: boolean;
}

export interface ResetWorkspacesResult {
  dryRun: boolean;
  keepData: boolean;
  /** Live workspaces that were (or would be) queued for deletion. */
  workspaces: { slug: string; status: string }[];
  /** Users whose onboarding was (or would be) reset. */
  usersReset: number;
}

/**
 * Admin-run maintenance: delete every live workspace (the worker's `delete_tenant` job does the
 * host work, with or without the home directory) and send every user back through onboarding
 * (`onboardedAt` cleared). With a wipe, saved tool selections and agent keys are removed too; a
 * keep-data reset leaves them so users re-create with the same choices. Sessions are revoked.
 * Nothing runs until the worker picks the jobs up; run with `dryRun` first.
 */
export async function resetAllWorkspaces(
  database: Db,
  opts: ResetWorkspacesOptions,
): Promise<ResetWorkspacesResult> {
  const live = await database
    .select({ id: workspaces.id, slug: workspaces.slug, status: workspaces.status })
    .from(workspaces)
    .where(notInArray(workspaces.status, ["deleted", "deleting"]));
  const users = await database.select({ id: user.id }).from(user);
  const result: ResetWorkspacesResult = {
    dryRun: opts.dryRun,
    keepData: opts.keepData,
    workspaces: live.map(({ slug, status }) => ({ slug, status })),
    usersReset: users.length,
  };
  if (opts.dryRun) return result;

  await database.transaction(async (tx) => {
    const ids = live.map((w) => w.id);
    if (ids.length > 0) {
      await tx.update(workspaces).set({ status: "deleting" }).where(inArray(workspaces.id, ids));
      await tx
        .update(workspaceSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(inArray(workspaceSessions.workspaceId, ids), isNull(workspaceSessions.revokedAt)),
        );
      await tx
        .insert(jobs)
        .values(
          ids.map((workspaceId) => ({
            type: "delete_tenant" as const,
            workspaceId,
            payload: { keepData: opts.keepData },
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(user)
      .set(
        opts.keepData ? { onboardedAt: null } : { onboardedAt: null, onboardingSelection: null },
      );
    if (!opts.keepData) await tx.delete(agentKeys);
    await tx.insert(auditLog).values({
      actorId: null,
      action: "admin.reset_workspaces",
      targetType: "system",
      targetId: null,
      metadata: { keepData: opts.keepData, workspaces: live.map((w) => w.slug) },
      ip: null,
    });
  });
  return result;
}
