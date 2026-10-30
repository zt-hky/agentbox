"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { decrypt } from "@agentbox/core/tokens";
import { db } from "@agentbox/db/client";
import {
  cancelOrSignOutCopilot,
  disconnectGithubAccount,
  getCopilotView,
  requestCopilotLogin,
  type CopilotView,
} from "@/lib/accounts";
import { guard } from "@/lib/action";
import { clientIpFrom } from "@/lib/audit";
import { encryptionKey, githubConnectConfig } from "@/lib/env";
import { revokeConnection } from "@/lib/github";
import { requireOnboardedUser } from "@/lib/session";

export async function disconnectGithub() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    const conn = await disconnectGithubAccount(db, {
      userId: user.id,
      ip: clientIpFrom(await headers()),
    });
    if (!conn) return;

    const cfg = githubConnectConfig();
    if (cfg) {
      try {
        await revokeConnection(cfg, decrypt(conn.tokenEnc, encryptionKey()));
      } catch (e) {
        console.error("github revoke failed", e);
      }
    }
    revalidatePath("/settings/github");
  });
}

export async function startCopilotLogin() {
  return guard(async (): Promise<CopilotView> => {
    const { user } = await requireOnboardedUser();
    const view = await requestCopilotLogin(db, {
      userId: user.id,
      ip: clientIpFrom(await headers()),
    });
    revalidatePath("/settings/github");
    return view;
  });
}

/** Cancels a live sign-in, or signs Copilot out of the workspace when it already finished. */
export async function cancelOrSignOutCopilotAction() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    await cancelOrSignOutCopilot(db, { userId: user.id, ip: clientIpFrom(await headers()) });
    revalidatePath("/settings/github");
  });
}

/** Polled by the sign-in panel while the device code is shown. */
export async function pollCopilotState() {
  return guard(async () => {
    const { user } = await requireOnboardedUser();
    return (await getCopilotView(db, user.id)).copilot;
  });
}
