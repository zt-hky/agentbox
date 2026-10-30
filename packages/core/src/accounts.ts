import { z } from "zod";

/** Account integrations beyond the gh token: GitHub scopes, Copilot sign-in, T3 Copilot provider. */

/** Minimum OAuth scopes; `workflow` is an explicit opt-in (re-consent). */
/** `write:public_key` lets AgentBox upload the workspace SSH key; tokens without it keep HTTPS only. */
export const GITHUB_BASE_SCOPES = ["repo", "read:org", "gist", "write:public_key"] as const;
export const GITHUB_WORKFLOW_SCOPE = "workflow";

export function githubScopeString(allowWorkflow: boolean): string {
  return [...GITHUB_BASE_SCOPES, ...(allowWorkflow ? [GITHUB_WORKFLOW_SCOPE] : [])].join(" ");
}

/** GitHub returns granted scopes comma-separated; ours are stored as given. Accept both. */
export function hasGithubScope(scopes: string | null | undefined, scope: string): boolean {
  return (scopes ?? "").split(/[\s,]+/).includes(scope);
}

/** The device-flow page `copilot login --device-code` points at; any other URL is never shown. */
export const COPILOT_DEVICE_URL = "https://github.com/login/device";
/** GitHub's device-code lifetime (15 minutes). */
export const COPILOT_DEVICE_CODE_TTL_S = 15 * 60;
/** Where the user revokes Copilot CLI's own OAuth grant (`/logout` does not revoke it). */
export const COPILOT_GRANT_SETTINGS_URL = "https://github.com/settings/applications";

/** Device-login session as the agent observes it inside the workspace. */
export const copilotLoginStatusSchema = z.enum([
  "idle",
  "starting",
  "code",
  "signed_in",
  "expired",
  "failed",
  "cancelled",
]);
export type CopilotLoginStatus = z.infer<typeof copilotLoginStatusSchema>;

export const copilotLoginStateSchema = z.object({
  status: copilotLoginStatusSchema,
  userCode: z.string().nullable(),
  verificationUri: z.string().nullable(),
  /** ISO time the device code stops working. */
  expiresAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type CopilotLoginState = z.infer<typeof copilotLoginStateSchema>;

export const COPILOT_TERMINAL_STATUSES: readonly CopilotLoginStatus[] = [
  "signed_in",
  "expired",
  "failed",
  "cancelled",
];

/** PUT /v1/workspaces/:ws/copilot/provider: seed or remove the T3 Copilot provider instance. */
export const copilotProviderRequestSchema = z.object({ enabled: z.boolean() });
export type CopilotProviderRequest = z.infer<typeof copilotProviderRequestSchema>;

/** `workspace_integrations.status` for kind `copilot`. */
export const COPILOT_INTEGRATION_STATUSES = [
  "starting",
  "code",
  "signed_in",
  "expired",
  "failed",
  "cancelling",
  "cancelled",
  "signing_out",
] as const;
export type CopilotIntegrationStatus = (typeof COPILOT_INTEGRATION_STATUSES)[number];

/** `workspace_integrations.detail` for kind `copilot`. */
export const copilotDetailSchema = z.object({
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  expiresAt: z.string().optional(),
  /** Sign-in worked but seeding the T3 provider did not; retried on the next account sync. */
  providerError: z.string().optional(),
  error: z.string().optional(),
  signedInAt: z.string().optional(),
});
export type CopilotDetail = z.infer<typeof copilotDetailSchema>;
