import { and, eq, ne } from "drizzle-orm";
import { accessRequests, workspaces } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";
import { checkSlug, type SlugCheck } from "./slug";

/**
 * Taken when a workspace owns the slug, or another user's pending request asks for it.
 * `forUserId`'s own pending request never blocks them.
 */
export function checkSlugAvailable(
  database: DbLike,
  slug: string,
  forUserId: string,
): Promise<SlugCheck> {
  return checkSlug(slug, async (s) => {
    const ws = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, s))
      .limit(1);
    if (ws.length > 0) return true;
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
    return req.length > 0;
  });
}
