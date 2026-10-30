import { randomToken } from "@agentbox/core/tokens";
import { githubConnectConfig } from "@/lib/env";
import { WORKFLOW_PARAM, authorizeUrl, redirectResponse, stateCookie } from "@/lib/github";
import { getSession } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active") return redirectResponse("/login");
  const cfg = githubConnectConfig();
  if (!cfg) return new Response("GitHub connection is not configured", { status: 404 });

  // `?workflow=1` is the explicit opt-in for the `workflow` scope (re-consent on an existing link).
  const allowWorkflow = new URL(request.url).searchParams.get(WORKFLOW_PARAM) === "1";
  const state = randomToken();
  return redirectResponse(authorizeUrl(cfg.clientId, state, allowWorkflow), [stateCookie(state)]);
}
