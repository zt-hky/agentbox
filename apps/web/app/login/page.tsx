import type { Metadata } from "next";
import { Box } from "lucide-react";
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
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Box className="size-4" />
          </div>
          AgentBox
        </div>
        <LoginForm providers={configuredProviders()} next={sanitizeNextPath(next)} error={error} />
      </div>
    </div>
  );
}
