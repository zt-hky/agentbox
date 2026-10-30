import { and, eq } from "drizzle-orm";
import {
  AGENT_CREDENTIAL_ENV_VARS,
  findCredentialSpec,
  maskCredential,
  normalizeCredentialValue,
} from "@agentbox/core/agent-credentials";
import { decrypt, encrypt } from "@agentbox/core/tokens";
import { agentKeys, workspaces } from "@agentbox/db/schema";
import { writeAudit } from "./audit";
import type { DbLike } from "./db-types";
import { UserError } from "./errors";
import { enqueueWorkspaceJob } from "./jobs";

export interface AgentKeyActor {
  userId: string;
  encryptionKey: string;
  ip: string | null;
}

export interface SavedAgentKey {
  envVar: string;
  masked: string;
  updatedAt: string;
}

/** Saved keys with a masked display form; the secret never leaves the server. */
export async function listAgentKeys(
  database: DbLike,
  userId: string,
  encryptionKey: string,
): Promise<SavedAgentKey[]> {
  const rows = await database.select().from(agentKeys).where(eq(agentKeys.userId, userId));
  return rows
    .filter((r) => AGENT_CREDENTIAL_ENV_VARS.includes(r.envVar))
    .map((r) => ({
      envVar: r.envVar,
      masked: maskCredential(decrypt(r.valueEnc, encryptionKey)),
      updatedAt: r.updatedAt.toISOString(),
    }));
}

/** Queue a sync into the user's live workspace; a sleeping one syncs on its next start. */
async function queueSync(database: DbLike, userId: string): Promise<void> {
  const [ws] = await database
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .limit(1);
  if (ws && ws.status !== "deleted" && ws.status !== "deleting") {
    await enqueueWorkspaceJob(database, ws.id, { type: "sync_agent_keys" });
  }
}

export async function saveAgentKey(
  database: DbLike,
  actor: AgentKeyActor,
  input: { agentId: string; envVar: string; value: string },
): Promise<{ masked: string }> {
  if (!findCredentialSpec(input.agentId, input.envVar)) {
    throw new UserError("That credential is not used by this agent");
  }
  const value = normalizeCredentialValue(input.value);
  if (!value) throw new UserError("Paste the key on a single line without spaces");
  const valueEnc = encrypt(value, actor.encryptionKey);
  await database
    .insert(agentKeys)
    .values({ userId: actor.userId, envVar: input.envVar, valueEnc })
    .onConflictDoUpdate({
      target: [agentKeys.userId, agentKeys.envVar],
      set: { valueEnc, updatedAt: new Date() },
    });
  await writeAudit(database, {
    actorId: actor.userId,
    action: "agent_key.save",
    targetType: "user",
    targetId: actor.userId,
    metadata: { agentId: input.agentId, envVar: input.envVar },
    ip: actor.ip,
  });
  await queueSync(database, actor.userId);
  return { masked: maskCredential(value) };
}

export async function removeAgentKey(
  database: DbLike,
  actor: AgentKeyActor,
  input: { agentId: string; envVar: string },
): Promise<void> {
  if (!findCredentialSpec(input.agentId, input.envVar)) {
    throw new UserError("That credential is not used by this agent");
  }
  await database
    .delete(agentKeys)
    .where(and(eq(agentKeys.userId, actor.userId), eq(agentKeys.envVar, input.envVar)));
  await writeAudit(database, {
    actorId: actor.userId,
    action: "agent_key.remove",
    targetType: "user",
    targetId: actor.userId,
    metadata: { agentId: input.agentId, envVar: input.envVar },
    ip: actor.ip,
  });
  await queueSync(database, actor.userId);
}

/** Remove every saved key (wipe-delete of a workspace). */
export async function clearAgentKeys(database: DbLike, userId: string): Promise<void> {
  await database.delete(agentKeys).where(eq(agentKeys.userId, userId));
}
