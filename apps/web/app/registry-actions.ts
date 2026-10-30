"use server";

import { registryTool, searchRegistry, type RegistryHit } from "@agentbox/core/toolchain";
import { db } from "@agentbox/db/client";
import { requireActiveUser } from "@/lib/session";
import { loadRegistryVersions } from "@/lib/toolchain/registry-versions";

/**
 * Search the mise registry snapshot: name/alias prefix matches first, then substring matches, at
 * most 20. Shared by onboarding (step 1) and the Tools page; an empty query returns nothing.
 */
export async function searchMiseTools(query: string): Promise<RegistryHit[]> {
  await requireActiveUser();
  return searchRegistry(typeof query === "string" ? query.slice(0, 64) : "");
}

/**
 * Published versions of a registry tool, newest first (at most 50, stable releases only), for the
 * version select. Empty when the tool has no listable source or the source is unreachable; the UI
 * then offers free text.
 */
export async function registryToolVersions(id: string): Promise<string[]> {
  await requireActiveUser();
  if (typeof id !== "string" || !registryTool(id)) return [];
  return loadRegistryVersions(db, id);
}
