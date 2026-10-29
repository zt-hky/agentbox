import { randomToken } from "@agentbox/core/tokens";
import { githubConnectConfig } from "@/lib/env";
import { authorizeUrl, redirectResponse, stateCookie } from "@/lib/github";
import { getSession } from "@/lib/session";

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active") return redirectResponse("/login");
  const cfg = githubConnectConfig();
  if (!cfg) return new Response("GitHub connection is not configured", { status: 404 });

  const state = randomToken();
  return redirectResponse(authorizeUrl(cfg.clientId, state), [stateCookie(state)]);
}
