import { GIT_OAUTH } from "@agentbox/core/git";
import { handleGitCallback, parseOAuthProvider } from "@/lib/git-callback";

/** GitLab and Bitbucket redirect here; GitHub keeps the callback paths registered with its apps. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const provider = parseOAuthProvider((await ctx.params).provider);
  if (!provider || GIT_OAUTH[provider].callbackPath === null) {
    return new Response("Not found", { status: 404 });
  }
  return handleGitCallback(provider, request);
}
