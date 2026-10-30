# Accounts: git hosts, Copilot, VS Code

User page: `/settings/accounts` ("Accounts"; `/settings/github` redirects). The same
`components/git-accounts.tsx` renders the onboarding Accounts step. Desired state lives in the DB;
the worker applies it inside the workspace container through the agent, now if the workspace runs,
otherwise on next start (`workspaces.git_sync_pending`).

## Git hosts (clone, pull, push over HTTPS and SSH)

`git_connections` holds one row per `(user, host)`: provider, method (`oauth` | `token`), login,
commit email, provider user id, encrypted access token and refresh token (`encrypt`/`decrypt` from
`@agentbox/core/tokens`), `expires_at`, granted `scopes`, `ssh_key_id` (id of the workspace public key
at the provider), `known_hosts` (self-hosted scan), `status` (`active` | `error`) and `last_error`.
`workspaces.ssh_public_key` is the workspace's own public key; the private key never leaves the
workspace. The provider registry (OAuth endpoints, scopes, API roots, pinned SSH host keys, host
validation) is `packages/core/src/git.ts`; provider API calls are `packages/core/src/git-api.ts`.

| provider                          | host          | method                                        | notes                                                                                    |
| --------------------------------- | ------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `github`                          | github.com    | OAuth                                         | scopes `repo read:org gist write:public_key` (`workflow` opt-in)                         |
| `gitlab`                          | gitlab.com    | OAuth (`GITLAB_CLIENT_ID`/`_SECRET`) or token | scopes `api read_user write_repository`; access token expires ~2 h, refreshed            |
| `bitbucket`                       | bitbucket.org | OAuth (`BITBUCKET_CLIENT_ID`/`_SECRET`)       | scopes `account repository:write pullrequest`; expires ~2 h, refreshed; no commit email  |
| `gitlab-self`, `gitea`, `generic` | user-entered  | token                                         | verified through the host API (`/api/v4/user`, `/api/v1/user`); `generic` only by format |

A provider whose OAuth env is absent shows "Not configured by the administrator" and the token
method for that host remains (Bitbucket without OAuth: provider `generic`, host `bitbucket.org`, app
password).

### Connect

- OAuth: `GET /api/git/{github|gitlab|bitbucket}/connect[?next=/onboarding][&workflow=1]` sets the
  state cookie `__Host-abx_git_state` (and `__Host-abx_git_next` for onboarding) and redirects to the
  provider. Callbacks: `/api/git/gitlab/callback`, `/api/git/bitbucket/callback`; GitHub keeps the
  callback paths registered with its apps (see "GitHub app selection"). `handleGitCallback` verifies
  the state, exchanges the code, reads the profile, then `upsertGitConnection` stores the row and
  queues `sync_git` in one transaction. It returns to `<base>?connected=<provider>` or
  `<base>?error=state|exchange|denied`; `<base>` is `/onboarding` or `/settings/accounts`.
- Token: `addGitTokenAccount` (server action) -> `addGitTokenConnection`. The host must be a bare
  public https hostname: no scheme, port, path, IP literal, `localhost` or local-only suffix
  (`normalizeGitHost`), and every address it resolves to must be public (the web server calls it).
  The token is verified against the host API (GitLab, Gitea); a rejected token stores nothing. For
  hosts without shipped keys the web server runs `ssh-keyscan` and stores the key lines in
  `git_connections.known_hosts`. Adding a token for an existing host replaces it; the uploaded key id is kept
  only when the provider account is the same.
- Reconnecting an OAuth connection resets `status`/`last_error`.

### Workspace reconcile (`sync_git`)

The worker (`reconcileGit`, `apps/worker/src/git.ts`) pushes the full desired state with
`PUT /v1/workspaces/:ws/git`:

```json
{
  "connections": [
    {
      "provider": "github",
      "host": "github.com",
      "login": "octo",
      "token": "...",
      "username": "octo",
      "knownHosts": "..."
    }
  ],
  "identity": { "name": "octo", "email": "42+octo@users.noreply.github.com" }
}
```

and stores the returned `{ sshPublicKey }` in `workspaces.ssh_public_key`. `username` is what git
presents over HTTPS: the login for GitHub OAuth and every token connection, `oauth2` for GitLab
OAuth, `x-token-auth` for Bitbucket OAuth. A sleeping workspace only gets `git_sync_pending`; the
next start reconciles. An agent 409 (container not running) leaves the flag set.

The agent (`apps/agent/src/git.ts`) makes the workspace match that state exactly:

- **SSH key**: `~/.ssh/agentbox_ed25519` (ed25519, comment `agentbox:<slug>`) is created once and
  reused; a lost `.pub` is rebuilt from the private key. Keep-data recreates reuse the key file.
- **ssh config**: a managed block between `# >>> agentbox` and `# <<< agentbox` in `~/.ssh/config`
  with a `Host` section (`User git`, `IdentityFile ~/.ssh/agentbox_ed25519`, `IdentitiesOnly yes`) per
  connection; user content outside the block is preserved. Hosts with no known keys get
  `StrictHostKeyChecking accept-new`.
- **known_hosts**: a managed block in `~/.ssh/known_hosts` with the official keys for github.com,
  gitlab.com and bitbucket.org (shipped in core with their SHA256 fingerprints, checked in tests) and
  the stored scan for self-hosted hosts. Scan lines are accepted only for their own host.
- **HTTPS**: `~/.agentbox/git-credentials` (0600, replaced whole) holds `https://user:token@host`
  lines (percent-encoded) for every connection except GitHub, with
  `git config --global credential.https://<host>.helper "store --file <HOME>/.agentbox/git-credentials"`
  per host. Helpers for hosts that are no longer connected are removed; other helpers the user
  configured stay. GitHub uses `gh auth login --with-token` + `gh auth setup-git`; when GitHub is not
  connected the agent runs `gh auth logout` and `removeGhCredentialHelpers`.
- **Identity**: `user.name`/`user.email` are set only when unset, from the first connected account
  (GitHub if linked, else the oldest). Emails: GitHub noreply, GitLab `commit_email` /
  `public_email` / `<id>-<username>@users.noreply.gitlab.com`; Bitbucket has none, so no identity.

### SSH key upload

After the agent returns the key, the worker uploads it, titled `AgentBox <slug>`, to every active
connection that can take it: GitHub (`POST /user/keys`, needs the `write:public_key` scope; older
tokens without it show "Reconnect to enable SSH"), GitLab and self-managed GitLab
(`POST /api/v4/user/keys`), Gitea/Forgejo (`POST /api/v1/user/keys`), Bitbucket OAuth
(`POST /2.0/users/{uuid}/ssh-keys`). It is idempotent: the existing keys are listed first and the same
key material is reused. The id is stored in `ssh_key_id` and later syncs skip the connection. If the
workspace key changes (recreated without its data), the old key is deleted at the provider and the
new one uploaded. A 4xx from the provider (scope, key already in use) is recorded in `last_error` and
does not fail the sync; a network error or 5xx applies everything else and then fails the job so it
retries. For hosts that cannot take a key through an API the Accounts page shows the workspace public
key to add by hand.

### Token refresh

`startGitRefreshLoop` (worker, every 15 min) refreshes active OAuth connections whose `expires_at` is
within 30 minutes, using the refresh token and the worker's `GITLAB_*`/`BITBUCKET_*` env. The new
tokens are stored; a running workspace gets `sync_git` to rewrite the credential store, a sleeping
one `git_sync_pending`. A rejected refresh (4xx) sets `status='error'` and `last_error` and the UI
asks to reconnect; a network error or 5xx is retried next cycle. SSH keeps working regardless of
token expiry, which is the durable path.

Env: `GITLAB_CLIENT_ID`/`_SECRET` and `BITBUCKET_CLIENT_ID`/`_SECRET` go into `optional.env`
(`infra/cp/secrets.sh`), which both the web and the worker container load. The web image ships
`openssh-client` for the self-hosted `ssh-keyscan`.

### Disconnect

`disconnectGitAccount` -> `disconnectGitConnection` (one transaction): deletes the row, queues
`sync_git` (the agent drops that host's credentials, helper and ssh block; without GitHub it logs
`gh` out), marks a Copilot sign-in for sign-out (or cancels a live one) when the host was GitHub, and
audits `git.disconnected`. Then, best effort and never blocking (`releaseDisconnectedConnection`),
the uploaded SSH key is deleted at the provider and the OAuth grant revoked (GitHub: dedicated app
the whole grant, shared app only the token; GitLab: `/oauth/revoke`; Bitbucket has no revoke call).

### GitHub app selection

`gitOAuthConfig("github")`: `GITHUB_CONNECT_CLIENT_ID`/`_SECRET` (dedicated app, callback
`/api/github/callback`) win; otherwise the sign-in app `GITHUB_CLIENT_ID`/`_SECRET` is reused with its
exact registered callback `/api/auth/callback/github` (GitHub rejected a subdirectory of it in
production). The better-auth catch-all hands that request to Connect only when its `state` matches
Connect's state cookie; everything else is sign-in. Neither set: "Not configured". A shared app may
request the extra scopes; sign-in itself still asks only `read:user user:email`. Because that grant is
also the user's sign-in authorization, Disconnect on a shared app revokes only the token
(`DELETE /applications/{client_id}/token`), never `/grant`.

### Migration

`0011_git_accounts` creates `git_connections`, copies every `github_connections` row (provider
`github`, host `github.com`, method `oauth`, `github_id` as `provider_user_id`), drops the old table,
renames `workspaces.github_sync_pending` to `git_sync_pending` (value kept), adds
`workspaces.ssh_public_key` and converts `sync_github` jobs to `sync_git`. Existing GitHub tokens
lack `write:public_key`; they keep HTTPS and show "Reconnect to enable SSH".

## Copilot (CLI + T3 provider)

- The `copilot` CLI comes from the toolchain catalog (`/tools`); sign-in needs it installed.
- Sign-in is the CLI's own `copilot login --device-code` (separate OAuth app, needs a Copilot plan),
  run detached inside the running workspace. State machine: `starting -> code -> signed_in`, or
  `expired` (15 min), `failed`, `cancelled`; `cancelling` and `signing_out` are user requests.
  - web `requestCopilotLogin` writes the `workspace_integrations` row (`kind=copilot`) and queues
    `copilot_login` (short job: starts the CLI). The worker loop `pollCopilotLogins` (every 2 s)
    mirrors the agent's session state into the row; the page polls the row. A sign-in never holds
    the workspace's job slot, so idle/stop jobs are not blocked by a human.
  - Agent endpoints: `POST|GET|DELETE /v1/workspaces/:ws/copilot/login`,
    `DELETE /v1/workspaces/:ws/copilot` (sign-out), `PUT /v1/workspaces/:ws/copilot/provider`.
  - The verification URL is only ever `https://github.com/login/device`; anything else fails the
    sign-in.
- Signed in = the CLI exited 0. The agent can only observe what the CLI prints, so the stored login
  is `~/.copilot/config.json` (plaintext, no keychain in the container).
- Sign-out (`signing_out`, reconciled by `sync_git`): cancels a session, deletes
  `~/.copilot/config.json`, removes the T3 provider. A login the user made in a terminal (no row)
  is never touched. GitHub keeps the authorization until the user removes "GitHub Copilot CLI" under
  Settings → Applications.
- T3 provider: on sign-in and on every sync, `providerInstances.copilot = {driver: "acpRegistry",
config: {source: "local", commandPath: "copilot", commandArgs: ["--acp"]}}` is merged into
  `~/.t3/userdata/settings.json` (T3 watches the file). Existing `copilot` entries are never
  overwritten; removal only deletes an entry that is exactly this one; invalid JSON is left alone
  and reported as `providerError`.

## VS Code (code-server)

Guidance only. Git works through the credential helpers and SSH key above without a VS Code sign-in. The GitHub
account in VS Code's Accounts menu cannot be preset. Copilot Chat is not offered: it is not on
Open VSX and Marketplace terms limit it to Microsoft products.
