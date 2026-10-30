import { and, eq, ne } from "drizzle-orm";
import { accessRequests, user, workspaces } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";
import { checkSlug, slugFromEmail, type SlugCheck } from "./slug";

/**
 * Taken when a workspace owns the slug, another user's pending request asks for it, or another
 * user's approval reserved it.
 * `forUserId`'s own pending request never blocks them, and neither does their own `deleted`
 * workspace: re-creating reuses that row. A `deleted` row of someone else keeps its slug
 * reserved (`workspaces.slug` is unique and the row is kept for history).
 */
export function checkSlugAvailable(
  database: DbLike,
  slug: string,
  forUserId: string,
): Promise<SlugCheck> {
  return checkSlug(slug, async (s) => {
    const ws = await database
      .select({ userId: workspaces.userId, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.slug, s))
      .limit(1);
    if (ws[0] && !(ws[0].userId === forUserId && ws[0].status === "deleted")) return true;
    const req = await database
      .select({ id: accessRequests.id })
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.requestedSlug, s),
          eq(accessRequests.status, "pending"),
          ne(accessRequests.userId, forUserId),
        ),
      )
      .limit(1);
    if (req.length > 0) return true;
    // A slug reserved at approval for another user (their workspace is created at onboarding).
    const reserved = await database
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.reservedSlug, s), ne(user.id, forUserId)))
      .limit(1);
    return reserved.length > 0;
  });
}

/**
 * A free slug for prefilling approve and request forms: the user's requested slug if still free,
 * else the email's local part, then that plus the email domain's first label
 * (`trucpham` -> `trucphamvikki`), then numbered (`trucpham2`, ...).
 */
export async function suggestAvailableSlug(
  database: DbLike,
  input: { email: string; userId: string; requestedSlug?: string | null },
): Promise<string> {
  const base = slugFromEmail(input.email);
  const domainLabel = (input.email.split("@")[1]?.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const candidates = [
    ...(input.requestedSlug ? [input.requestedSlug] : []),
    base,
    `${base}${domainLabel}`.slice(0, 20),
  ];
  for (let n = 2; n < 100; n++) candidates.push(`${base.slice(0, 20 - String(n).length)}${n}`);
  for (const candidate of candidates) {
    if ((await checkSlugAvailable(database, candidate, input.userId)).ok) return candidate;
  }
  return input.requestedSlug ?? base;
}
