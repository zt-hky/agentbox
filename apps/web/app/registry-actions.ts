"use server";

import { searchRegistry, type RegistryHit } from "@agentbox/core/toolchain";
import { requireActiveUser } from "@/lib/session";

/**
 * Search the mise registry snapshot: name/alias prefix matches first, then substring matches, at
 * most 20. Shared by onboarding (step 1) and the Tools page; an empty query returns nothing.
 */
export async function searchMiseTools(query: string): Promise<RegistryHit[]> {
  await requireActiveUser();
  return searchRegistry(typeof query === "string" ? query.slice(0, 64) : "");
}
