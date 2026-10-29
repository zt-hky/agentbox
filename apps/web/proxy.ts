import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/access";
import { getAuth } from "@/lib/auth";
import { generateNonce, securityHeaders } from "@/lib/csp";

// Next 16 `proxy` (formerly middleware) runs on the Node runtime, so it may query the database.
export async function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const secHeaders = securityHeaders(nonce, { dev: process.env.NODE_ENV !== "production" });
  const { pathname, search } = request.nextUrl;

  let user: { role?: string | null; accessStatus?: string | null } | null = null;
  if (pathname !== "/api/auth" && !pathname.startsWith("/api/auth/")) {
    try {
      const session = await getAuth().api.getSession({ headers: request.headers });
      user = session?.user ?? null;
    } catch (e) {
      console.error("proxy: session lookup failed", e);
      return withHeaders(new NextResponse("Service unavailable", { status: 503 }), secHeaders);
    }
  }

  const decision = decideAccess({ pathname, search, user });
  if (decision.type === "redirect") {
    // Next parses the Location header, so it must be absolute. The request URL says http:// behind
    // the TLS-terminating tunnel; X-Forwarded-Proto (kept by Caddy for loopback peers) has the truth.
    const target = new URL(decision.to, request.nextUrl);
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto === "https" || proto === "http") target.protocol = `${proto}:`;
    return withHeaders(
      new NextResponse(null, { status: 307, headers: { Location: target.toString() } }),
      secHeaders,
    );
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", secHeaders["Content-Security-Policy"]!);
  return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), secHeaders);
}

function withHeaders(res: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/).*)"],
};
