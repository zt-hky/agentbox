"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CHANNELS, toolIdSchema, versionSchema } from "@agentbox/core/toolchain";
import { db } from "@agentbox/db/client";
import { guard, type ActionResult } from "@/lib/action";
import { UserError } from "@/lib/errors";
import { refreshToolLatest, type RefreshResult } from "@/lib/toolchain/latest";
import {
  installTool,
  reinstallTool,
  removeTool,
  retryFailed,
  rollbackTool,
  selectToolVersion,
  upgradeAll,
  upgradeTool,
} from "@/lib/toolchain/ops";
import { loadRunPanel } from "@/lib/toolchain/view";
import { getClientIp, requireActiveUser } from "@/lib/session";

const toolInput = z.object({ toolId: toolIdSchema });
const selectionInput = z.object({
  toolId: toolIdSchema,
  selection: z.object({
    channel: z.enum(CHANNELS),
    pinnedVersion: versionSchema.nullish(),
  }),
});
const installInput = z.object({
  toolId: toolIdSchema,
  selection: selectionInput.shape.selection.optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserError("Invalid request");
  return r.data;
}

async function actor() {
  const { user } = await requireActiveUser();
  return { userId: user.id, ip: await getClientIp() };
}

async function done<T>(fn: () => Promise<T>) {
  return guard(async () => {
    const out = await fn();
    revalidatePath("/tools");
    return out;
  });
}

export async function installToolAction(input: unknown) {
  return done(async () => installTool(db, await actor(), parse(installInput, input)));
}

export async function removeToolAction(input: unknown) {
  return done(async () => removeTool(db, await actor(), parse(toolInput, input)));
}

export async function selectToolVersionAction(input: unknown) {
  return done(async () => selectToolVersion(db, await actor(), parse(selectionInput, input)));
}

export async function upgradeToolAction(input: unknown) {
  return done(async () => upgradeTool(db, await actor(), parse(toolInput, input)));
}

export async function rollbackToolAction(input: unknown) {
  return done(async () => rollbackTool(db, await actor(), parse(toolInput, input)));
}

export async function reinstallToolAction(input: unknown) {
  return done(async () => reinstallTool(db, await actor(), parse(toolInput, input)));
}

export async function upgradeAllAction() {
  return done(async () => upgradeAll(db, await actor()));
}

export async function retryFailedAction() {
  return done(async () => retryFailed(db, await actor()));
}

export async function checkForUpdatesAction(): Promise<ActionResult<RefreshResult>> {
  return done(async () => {
    const a = await actor();
    return refreshToolLatest(db, { actorId: a.userId, ip: a.ip, force: false });
  });
}

/** Polled every 2 s while a run is open; read-only. */
export async function pollRunAction() {
  return guard(async () => {
    const { user } = await requireActiveUser();
    return loadRunPanel(db, user.id);
  });
}
