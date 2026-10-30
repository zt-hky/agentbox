"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { CHANNELS, toolIdSchema, versionSchema } from "@agentbox/core/toolchain";
import { guard } from "@/lib/action";
import { removeAgentKey, saveAgentKey } from "@/lib/agent-keys";
import { encryptionKey } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { finishOnboarding, loadOnboardingProgress } from "@/lib/onboarding";
import { saveSelection } from "@/lib/onboarding-selection";
import { getClientIp, requireOnboardingUser } from "@/lib/session";
import { createWorkspaceForUser } from "@/lib/workspace-create";

const versionsInput = z.partialRecord(
  toolIdSchema,
  z.object({ channel: z.enum(CHANNELS), pinnedVersion: versionSchema.nullish() }),
);
const toolsInput = z.object({
  toolIds: z.array(toolIdSchema).max(64),
  versions: versionsInput.optional(),
});
const agentsInput = z.object({ agentIds: z.array(toolIdSchema).max(64) });
const keyInput = z.object({
  agentId: toolIdSchema,
  envVar: z.string().min(1).max(64),
  value: z.string().min(1).max(8192),
});
const keyRemoveInput = keyInput.omit({ value: true });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserError(r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

async function actor() {
  const session = await requireOnboardingUser();
  return { userId: session.user.id, ip: await getClientIp() };
}

export async function saveToolSelectionAction(input: unknown) {
  return guard(async () => {
    const { userId } = await actor();
    const { toolIds, versions } = parse(toolsInput, input);
    const chosen = Object.fromEntries(
      Object.entries(versions ?? {}).flatMap(([id, v]) =>
        v ? [[id, { channel: v.channel, pinnedVersion: v.pinnedVersion ?? null }]] : [],
      ),
    );
    await saveSelection(db, userId, "runtime", toolIds, chosen);
  });
}

export async function saveAgentSelectionAction(input: unknown) {
  return guard(async () => {
    const { userId } = await actor();
    await saveSelection(db, userId, "agent", parse(agentsInput, input).agentIds);
  });
}

export async function saveAgentKeyAction(input: unknown) {
  return guard(async () => {
    const { userId, ip } = await actor();
    return saveAgentKey(db, { userId, ip, encryptionKey: encryptionKey() }, parse(keyInput, input));
  });
}

export async function removeAgentKeyAction(input: unknown) {
  return guard(async () => {
    const { userId, ip } = await actor();
    await removeAgentKey(
      db,
      { userId, ip, encryptionKey: encryptionKey() },
      parse(keyRemoveInput, input),
    );
  });
}

/** Step 4. Idempotent: calling it again while the workspace is being created does nothing. */
export async function startWorkspaceCreationAction() {
  return guard(async () => {
    const { userId, ip } = await actor();
    const res = await createWorkspaceForUser(db, { userId, ip, encryptionKey: encryptionKey() });
    return { workspaceId: res.workspaceId };
  });
}

/** Polled every ~2 s while the progress screen is open; read-only. */
export async function pollOnboardingProgressAction() {
  return guard(async () => {
    const { userId } = await actor();
    return loadOnboardingProgress(db, userId);
  });
}

export async function finishOnboardingAction() {
  return guard(async () => {
    const { userId, ip } = await actor();
    await finishOnboarding(db, userId, ip);
    revalidatePath("/", "layout");
  });
}
