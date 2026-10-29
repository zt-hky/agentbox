import { getAuth } from "@/lib/auth";
import { isBlockedAuthPath } from "@/lib/auth-paths";

// better-auth endpoints. The admin plugin's HTTP endpoints are blocked: every admin mutation in
// AgentBox goes through audited server actions instead.
async function handle(request: Request): Promise<Response> {
  if (isBlockedAuthPath(new URL(request.url).pathname)) {
    return new Response("Not found", { status: 404 });
  }
  return getAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
