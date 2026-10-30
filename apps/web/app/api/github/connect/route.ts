import { randomToken } from "@agentbox/core/tokens";
import { githubConnectConfig } from "@/lib/env";
import {
  ONBOARDING_RETURN,
  WORKFLOW_PARAM,
  authorizeUrl,
  nextCookie,
  redirectResponse,
  stateCookie,
} from "@/lib/github";
import { getSession } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active") return redirectResponse("/login");
  const cfg = githubConnectConfig();
  if (!cfg) return new Response("GitHub connection is not configured", { status: 404 });

  // `?workflow=1` is the explicit opt-in for the `workflow` scope (re-consent on an existing link).
  const params = new URL(request.url).searchParams;
  const allowWorkflow = params.get(WORKFLOW_PARAM) === "1";
  const state = randomToken();
  // `?next=/onboarding` (the only accepted value) returns to the wizard after the round trip.
  const fromOnboarding = params.get("next") === ONBOARDING_RETURN;
  return redirectResponse(authorizeUrl(cfg, state, allowWorkflow), [
    stateCookie(state),
    nextCookie(fromOnboarding ? ONBOARDING_RETURN : "", fromOnboarding ? undefined : 0),
  ]);
}
