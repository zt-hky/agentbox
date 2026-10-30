import { randomToken } from "@agentbox/core/tokens";
import { gitOAuthConfig } from "@/lib/env";
import { parseOAuthProvider } from "@/lib/git-callback";
import {
  ONBOARDING_RETURN,
  WORKFLOW_PARAM,
  authorizeUrl,
  nextCookie,
  redirectResponse,
  stateCookie,
} from "@/lib/git-oauth";
import { getSession } from "@/lib/session";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const provider = parseOAuthProvider((await ctx.params).provider);
  if (!provider) return new Response("Not found", { status: 404 });
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active") return redirectResponse("/login");
  const cfg = gitOAuthConfig(provider);
  if (!cfg) return new Response("This git provider is not configured", { status: 404 });

  // `?workflow=1` is GitHub's explicit opt-in for the `workflow` scope (re-consent on an existing link).
  const params = new URL(request.url).searchParams;
  const allowWorkflow = provider === "github" && params.get(WORKFLOW_PARAM) === "1";
  const state = randomToken();
  // `?next=/onboarding` (the only accepted value) returns to the wizard after the round trip.
  const fromOnboarding = params.get("next") === ONBOARDING_RETURN;
  return redirectResponse(authorizeUrl(provider, cfg, state, allowWorkflow), [
    stateCookie(state),
    nextCookie(fromOnboarding ? ONBOARDING_RETURN : "", fromOnboarding ? undefined : 0),
  ]);
}
