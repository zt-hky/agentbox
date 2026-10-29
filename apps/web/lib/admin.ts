import { getClientIp, requireAdmin, type AppSession } from "./session";

/** Every admin server action starts here: re-checks the admin role and captures the client IP. */
export async function adminContext(): Promise<{ admin: AppSession["user"]; ip: string | null }> {
  const session = await requireAdmin();
  return { admin: session.user, ip: await getClientIp() };
}
