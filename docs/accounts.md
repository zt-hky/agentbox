# Accounts: GitHub, Copilot, VS Code

User page: `/settings/github` ("Accounts"). Desired state lives in the DB; the worker applies it
inside the workspace container through the agent, now if the workspace runs, otherwise on next
start (`workspaces.github_sync_pending`).

## GitHub (gh + git)

- OAuth App web flow. Default scope `repo read:org gist`. `workflow` is an explicit opt-in:
  `/api/github/connect?workflow=1` re-consents; the granted scopes are stored in
  `github_connections.scopes` and shown on the page. Dropping `workflow` again needs Disconnect.
- Connect (`sync_github`): `gh auth login --with-token`, `gh auth setup-git`, git identity if unset.
- Disconnect (`disconnectGithubAccount`, one transaction): deletes the row, queues `sync_github`,
  marks a Copilot sign-in made from the page for sign-out (or cancels a live one), audits
  `github.disconnected`; the action then revokes the grant at GitHub. The agent's
  `DELETE /v1/workspaces/:ws/github` runs `gh auth logout` and removes the
  `credential.https://github.com` and `credential.https://gist.github.com` sections `gh auth
setup-git` wrote, but only when every helper in the section is gh's.

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
- Sign-out (`signing_out`, reconciled by `sync_github`): cancels a session, deletes
  `~/.copilot/config.json`, removes the T3 provider. A login the user made in a terminal (no row)
  is never touched. GitHub keeps the authorization until the user removes "GitHub Copilot CLI" under
  Settings → Applications.
- T3 provider: on sign-in and on every sync, `providerInstances.copilot = {driver: "acpRegistry",
config: {source: "local", commandPath: "copilot", commandArgs: ["--acp"]}}` is merged into
  `~/.t3/userdata/settings.json` (T3 watches the file). Existing `copilot` entries are never
  overwritten; removal only deletes an entry that is exactly this one; invalid JSON is left alone
  and reported as `providerError`.

## VS Code (code-server)

Guidance only. Git works through the gh credential helper without a VS Code sign-in. The GitHub
account in VS Code's Accounts menu cannot be preset. Copilot Chat is not offered: it is not on
Open VSX and Marketplace terms limit it to Microsoft products.
