"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { configuredProviders, type LoginProvider } from "@/lib/env";
import { sanitizeNextPath } from "@/lib/paths";

export async function signInWithProvider(formData: FormData): Promise<void> {
  const provider = String(formData.get("provider") ?? "") as LoginProvider;
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  if (!configuredProviders().includes(provider)) redirect("/login?error=provider");

  const res = await getAuth().api.signInSocial({
    body: { provider, callbackURL: next, errorCallbackURL: "/login?error=oauth" },
    headers: await headers(),
  });
  if (!res.url) redirect("/login?error=oauth");
  redirect(res.url);
}

export async function signOut(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}
