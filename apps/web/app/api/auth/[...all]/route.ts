import { getAuth } from "@/lib/auth";
import { isBlockedAuthPath } from "@/lib/auth-paths";
import { GITHUB_SHARED_CALLBACK_PATH } from "@/lib/env";
import { isConnectCallback } from "@/lib/github";
import { handleGithubCallback } from "@/lib/github-callback";

// better-auth endpoints. The admin plugin's HTTP endpoints are blocked: every admin mutation in
// AgentBox goes through audited server actions instead.
async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isBlockedAuthPath(pathname)) {
    return new Response("Not found", { status: 404 });
  }
  // Connect may share the sign-in OAuth App and its exact callback URL; its state cookie tells them apart.
  if (
    request.method === "GET" &&
    pathname === GITHUB_SHARED_CALLBACK_PATH &&
    isConnectCallback(request)
  ) {
    return handleGithubCallback(request);
  }
  return getAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
