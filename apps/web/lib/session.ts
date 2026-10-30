import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
import { clientIpFrom } from "./audit";

export const getSession = cache(async () => {
  return getAuth().api.getSession({ headers: await headers() });
});

export type AppSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export async function getClientIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

export function isAdminUser(u: { role?: string | null; accessStatus?: string | null }): boolean {
  return u.role === "admin" && u.accessStatus === "active";
}

/** Signed in at all (any access status). */
export async function requireUser(): Promise<AppSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Signed in with an `active` access status. */
export async function requireActiveUser(): Promise<AppSession> {
  const s = await requireUser();
  if (s.user.accessStatus !== "active") redirect("/request-access");
  return s;
}

/** Active and onboarded: everything but onboarding itself (dashboard, tools, billing, settings). */
export async function requireOnboardedUser(): Promise<AppSession> {
  const s = await requireActiveUser();
  if (!s.user.onboardedAt) redirect("/onboarding");
  return s;
}

/** Active but not yet onboarded: the onboarding wizard. Finished users go to the dashboard. */
export async function requireOnboardingUser(): Promise<AppSession> {
  const s = await requireActiveUser();
  if (s.user.onboardedAt) redirect("/");
  return s;
}

/** Admin gate for every admin layout and server action. */
export async function requireAdmin(): Promise<AppSession> {
  const s = await requireUser();
  if (!isAdminUser(s.user)) redirect("/");
  return s;
}
