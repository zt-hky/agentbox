import { db } from "@agentbox/db/client";
import { redirectResponse } from "@/lib/github";
import { issueHandoffCode } from "@/lib/handoff";
import { decideForRequest } from "@/lib/handoff-server";
import { sanitizeReturnPath } from "@/lib/paths";
import { getSession } from "@/lib/session";

/** GET /auth/handoff?host=&path= — start workspace sign-in for the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const session = await getSession();
  if (!session) {
    return redirectResponse(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const host = url.searchParams.get("host");
  const path = sanitizeReturnPath(url.searchParams.get("path"));

  const { decision, workspace } = await decideForRequest(host, session.user);
  if (decision.action === "deny") {
    return new Response(decision.reason, {
      status: decision.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (decision.action === "confirm") {
    const q = new URLSearchParams({ host: decision.host, path });
    return redirectResponse(`/auth/handoff/confirm?${q.toString()}`);
  }
  const target = await issueHandoffCode(db, {
    userId: session.user.id,
    workspaceId: workspace!.id,
    host: decision.host,
    returnPath: path,
  });
  return redirectResponse(target);
}
