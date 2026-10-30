import type { Metadata } from "next";
import { db } from "@agentbox/db/client";
import { Logo } from "@/components/logo";
import { loadOnboardingState } from "@/lib/onboarding";
import { requireOnboardingUser } from "@/lib/session";
import { Wizard } from "./wizard";

export const metadata: Metadata = { title: "Set up your workspace" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const session = await requireOnboardingUser();
  const state = await loadOnboardingState(db, session.user.id);
  const { connected, error } = await searchParams;
  // Coming back from the GitHub OAuth round trip lands on the accounts step.
  const initialStep = connected || error ? "accounts" : state.step;
  const firstName = session.user.name.split(" ")[0] || session.user.name;

  return (
    <div className="min-h-svh bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10 sm:px-8">
        <div className="flex items-center gap-2.5 text-lg font-semibold">
          <Logo className="size-8" />
          AgentBox
        </div>
        <div className="space-y-1.5">
          <h1 className="text-title">Set up your workspace, {firstName}</h1>
          <p className="text-sm text-muted-foreground">
            Four short steps: choose your languages and package managers, pick your agents and sign
            them in, then we build the machine. You can change every choice later under Tools.
          </p>
        </div>
        <Wizard
          state={state}
          initialStep={initialStep}
          gitError={error ?? null}
          gitConnected={connected ?? null}
        />
      </main>
    </div>
  );
}
