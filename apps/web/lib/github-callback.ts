import { headers } from "next/headers";
import { encrypt } from "@agentbox/core/tokens";
import { db } from "@agentbox/db/client";
import { githubConnections, workspaces } from "@agentbox/db/schema";
import { eq } from "drizzle-orm";
import { encryptionKey, githubConnectConfig } from "@/lib/env";
import {
  GH_NEXT_COOKIE,
  GH_STATE_COOKIE,
  exchangeCode,
  fetchGithubUser,
  nextCookie,
  readCookie,
  redirectResponse,
  returnBase,
  stateCookie,
  statesMatch,
} from "@/lib/github";
import { enqueueWorkspaceJob } from "@/lib/jobs";
import { getSession } from "@/lib/session";

export async function handleGithubCallback(request: Request): Promise<Response> {
  const clearState = stateCookie("", 0);
  const clear = [clearState, nextCookie("", 0)];
  const session = await getSession();
  if (!session || session.user.accessStatus !== "active")
    return redirectResponse("/login", [clearState]);
  const cfg = githubConnectConfig();
  if (!cfg) return new Response("GitHub connection is not configured", { status: 404 });

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieHeader = (await headers()).get("cookie");
  const cookieState = readCookie(cookieHeader, GH_STATE_COOKIE);
  const base = returnBase(readCookie(cookieHeader, GH_NEXT_COOKIE));
  if (!code || !statesMatch(state, cookieState)) {
    return redirectResponse(`${base}?error=state`, clear);
  }

  try {
    const { accessToken, scope } = await exchangeCode(cfg, code);
    const gh = await fetchGithubUser(accessToken);
    const tokenEnc = encrypt(accessToken, encryptionKey());
    await db.transaction(async (tx) => {
      await tx
        .insert(githubConnections)
        .values({
          userId: session.user.id,
          login: gh.login,
          githubId: BigInt(gh.id),
          tokenEnc,
          scopes: scope,
        })
        .onConflictDoUpdate({
          target: githubConnections.userId,
          set: { login: gh.login, githubId: BigInt(gh.id), tokenEnc, scopes: scope },
        });
      const ws = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.userId, session.user.id))
        .limit(1);
      if (ws[0] && ws[0].status !== "deleted" && ws[0].status !== "deleting") {
        await enqueueWorkspaceJob(tx, ws[0].id, { type: "sync_github" });
      }
    });
  } catch (e) {
    console.error("github connect failed", e);
    return redirectResponse(`${base}?error=exchange`, clear);
  }
  return redirectResponse(`${base}?connected=1`, clear);
}
