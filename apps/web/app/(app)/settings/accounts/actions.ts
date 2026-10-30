"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@agentbox/db/client";
import {
  cancelOrSignOutCopilot,
  disconnectGitConnection,
  getCopilotView,
  requestCopilotLogin,
  type CopilotView,
} from "@/lib/accounts";
import { guard } from "@/lib/action";
import { clientIpFrom } from "@/lib/audit";
import { UserError } from "@/lib/errors";
import { addGitTokenConnection, releaseDisconnectedConnection } from "@/lib/git-accounts";
import { requireActiveUser, requireOnboardedUser } from "@/lib/session";

// Git account actions also run from the onboarding wizard, before `onboardedAt` is set.

export async function disconnectGitAccount(connectionId: string) {
  return guard(async () => {
    const { user } = await requireActiveUser();
    const conn = await disconnectGitConnection(db, {
      userId: user.id,
      connectionId,
      ip: clientIpFrom(await headers()),
    });
    if (!conn) throw new UserError("That connection no longer exists");
    await releaseDisconnectedConnection(conn);
    revalidatePath("/settings/accounts");
  });
}

/** Add or replace (same user + host) a personal access token connection. */
export async function addGitTokenAccount(input: {
  provider: "gitlab" | "gitlab-self" | "gitea" | "generic";
  host: string;
  username: string;
  token: string;
}) {
  return guard(async () => {
    const { user } = await requireActiveUser();
    const res = await addGitTokenConnection(db, {
      userId: user.id,
      provider: input.provider,
      host: input.host,
      username: input.username,
      token: input.token,
      ip: clientIpFrom(await headers()),
    });
    revalidatePath("/settings/accounts");
    return res;
  });
}

export async function startCopilotLogin() {
  return guard(async (): Promise<CopilotView> => {
    const { user } = await requireOnboardedUser();
    const view = await requestCopilotLogin(db, {
      userId: user.id,
      ip: clientIpFrom(await headers()),
    });
    revalidatePath("/settings/accounts");
    return view;
  });
}

/** Cancels a live sign-in, or signs Copilot out of the workspace when it already finished. */
export async function cancelOrSignOutCopilotAction() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    await cancelOrSignOutCopilot(db, { userId: user.id, ip: clientIpFrom(await headers()) });
    revalidatePath("/settings/accounts");
  });
}

/** Polled by the sign-in panel while the device code is shown. */
export async function pollCopilotState() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    return (await getCopilotView(db, user.id)).copilot;
  });
}
