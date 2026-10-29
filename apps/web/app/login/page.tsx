import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { configuredProviders } from "@/lib/env";
import { sanitizeNextPath } from "@/lib/paths";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <AuthShell>
      <LoginForm providers={configuredProviders()} next={sanitizeNextPath(next)} error={error} />
    </AuthShell>
  );
}
