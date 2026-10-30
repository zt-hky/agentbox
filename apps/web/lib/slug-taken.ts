import { and, eq, ne } from "drizzle-orm";
import { accessRequests, workspaces } from "@agentbox/db/schema";
import type { DbLike } from "./db-types";
import { checkSlug, type SlugCheck } from "./slug";

/**
 * Taken when a workspace owns the slug, or another user's pending request asks for it.
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
    return req.length > 0;
  });
}
