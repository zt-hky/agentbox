# Onboarding and workspace lifecycle

## Access vs onboarding

- **Approval** (`/admin/requests`, `grantAccess` in `apps/web/lib/approve.ts`) activates access, creates
  the subscription (plan, trial, credit balance) and reserves the slug (`user.reserved_slug`). It does
  **not** create or provision a workspace.
- **Onboarding** is mandatory for every user whose `user.onboarded_at` is null, existing users
  included. Until it is set the dashboard and settings redirect to `/onboarding`
  (`requireOnboardedUser`), the workspace hand-off (`/auth/handoff`) is refused and the gateway
  (`apps/worker/src/gateway.ts`) denies T3 Code and VS Code. Admins keep access to the console and to
  other users' workspaces.

## Steps

1. Languages, in two ordered parts. 1a: pick languages, each with a version select (the catalog
   channels and recent lines, the default channel marked). 1b: the package managers of the picked
   languages (pnpm, Yarn for Node; uv, Poetry for Python; Maven, Gradle for Java), each with a version
   select; npm, pip, Cargo, Go modules and Bun's built-in manager are listed as included. Removing a
   language drops its package managers. Under the languages, "Search more tools from the mise registry"
   adds any other tool from the registry (see `docs/toolchain.md`): each picked tool is a card with a
   version control (Latest, or "Specific version" with a typed version) and a remove button; 1b
   ignores them. 2. Agent CLIs. Stored in `user.onboarding_selection`
   (`{tools, agents, versions?}`, `tools` holds languages, package managers and registry tools (`mise:<name>`), `versions` maps tool id
   to `{channel, pinnedVersion}`) until a workspace exists. Defaults come from the admin toolchain
   defaults, or from the workspace's current tools for a user who already has one. Creating the
   workspace writes the chosen channel and version into the new `workspace_tools` rows.
2. Accounts: git hosts through the shared accounts component (`/api/git/<provider>/connect?next=/onboarding`
   returns to `/onboarding?connected=<provider>|error=...`; see `docs/accounts.md`), and one optional key
   per agent (below).
3. Create workspace (`createWorkspaceForUser`, `apps/web/lib/workspace-create.ts`): inserts the
   workspace (`provisioning`, `toolchain_pending`), writes the selection as `workspace_tools` rows and
   queues `provision_tenant`. The worker provisions, then starts the workspace (a provision with
   `toolchain_pending` queues `start_workspace`); the start hook syncs git accounts and agent keys and queues
   the toolchain reconcile, which installs the tools. The wizard polls `loadOnboardingProgress`
   (provision, start, tools) and `finishOnboarding` sets `onboarded_at` once the workspace is up and the
   run has settled. A user who already has a live workspace gets the selection applied to it instead
   (tools added, unselected ones set to not desired, reconcile queued). Re-calling while creating is a
   no-op.

## Agent keys

`agent_keys` holds one encrypted value per `(user, env var)`, using the same AES-GCM helper and
`AGENTBOX_ENCRYPTION_KEY` as `git_connections`. Which variables each agent accepts is
`packages/core/src/agent-credentials.ts` (Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token`; Codex: `OPENAI_API_KEY`; Grok: `XAI_API_KEY`; Oh My Pi, Pi, OpenCode: the Anthropic
or OpenAI key). Keys are optional and skippable. The UI only ever sees a masked form.

Sync: the worker writes the full set to `~/.agentbox/secrets.env` (0600, atomic) through the agent route
`PUT /v1/workspaces/:ws/agent-keys` (container exec, values on stdin and redacted from logs).
`/opt/agentbox/env.sh` sources it, so new shells and tools see the keys; processes already running
(for example T3's server) read them after a restart. It runs on every workspace start and via the
`sync_agent_keys` job whenever a key is saved or removed. An empty set clears the file.

## Dashboard lifecycle

- Sleep: `stop_workspace` (reason `user`). Restart: `restart_workspace`.
- Delete (type the workspace name): sets `deleting`, revokes workspace sessions, clears `onboarded_at`
  and queues `delete_tenant`.
  - **Wipe**: the tenant home is removed with the host account; the saved selection and agent keys are
    cleared.
  - **Keep data**: the agent removes the container, quota, subids and host account but leaves
    `/srv/agentbox/tenants/<slug>` (tool configs, agent and account config, `/workspace` repos).
    The worker marks the row `deleted` with `data_kept = true`. Selection and keys are preserved.
- Re-creating (onboarding step 4) reuses the `deleted` row in place. With kept data it reuses the same
  slug and slot, so the home's file ownership still matches, and `createTenant` adopts the existing
  home directory. Without kept data it takes a fresh slot. Re-approval of a deleted user
  (`recreateWorkspace`) only resets onboarding and reserves the slug (the same slug when data is kept).

## Admin: reset every workspace (not run automatically)

`packages/db/scripts/reset-workspaces.ts` deletes all live workspaces (queues `delete_tenant` jobs; the
worker does the host work) and resets `onboarded_at` for every user. Wiping also clears saved selections
and agent keys. It prints a report and changes nothing unless `--yes` is given.

```sh
# on a host with DATABASE_URL pointing at the control-plane database
cd packages/db
node scripts/reset-workspaces.ts --keep-data          # dry run, keep every tenant home
node scripts/reset-workspaces.ts --keep-data --yes    # queue it
node scripts/reset-workspaces.ts --wipe --yes         # delete homes too
```

Run it only when you intend to send everyone back through onboarding.
