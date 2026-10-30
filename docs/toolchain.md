# Per-workspace toolchain

Runtimes (Node, Bun, Python) and agent CLIs (Claude Code, Codex, Oh My Pi, Pi, OpenCode, Grok, Muse,
GitHub Copilot CLI) are installed per workspace under `/workspace/home`, not baked into the shared
image. The image keeps only what every workspace needs to boot: apt tools, git, `gh`, `uv`, `mise`,
code-server, the T3 server, the resource monitor and `workspace-init`.

Evidence that every backend below installs as uid 1000 in a rootless container, with PATH, upgrade,
rollback, failure and removal behaviour: [`toolchain-spike.md`](toolchain-spike.md).

## Layout inside a workspace

| Path                                            | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `~/.local/share/mise/installs/<backend>/<ver>`  | mise install dirs (current and one previous version are kept)    |
| `~/.agentbox/bin/<name>`                        | PATH farm: symlinks (or exec wrappers) to the exact install file |
| `~/.agentbox/toolchain.json`                    | Observed state: version, previous, backend, bins, size           |
| `~/.agentbox/runs/<runId>/`, `~/.agentbox/logs` | Plan, step records, result and log of a run                      |

`/opt/agentbox/env.sh` (image-owned) puts `~/.agentbox/bin`, `~/.npm-global/bin` and `~/.local/bin` on
PATH and sets `MISE_DATA_DIR`, `MISE_CACHE_DIR`, `NPM_CONFIG_PREFIX`. `workspace-init`,
`/etc/profile.d/agentbox.sh`, `/etc/bash.bashrc` and every toolchain run source it, so a running T3
sees a newly installed CLI without a restart and T3 never needs a `binaryPath`. Install dirs live under
`/mise/installs/`, so T3 treats them as manually maintained and does not run its own updater.

## Catalog and versions

`packages/core/src/toolchain/catalog.ts` is the single source of truth: explicit mise backend strings
tried in order (no registry shorthands), bins, version command, version source, channels.

- Default for every tool is `latest`; Node's default channel is `lts`.
- Node and Python also offer older `major.minor` lines. A line resolves to the newest patch published
  in it. The server rejects any other pin for those tools. Bun and agent CLIs pin an exact version
  from the recent published list.
- Versions are resolved centrally by the worker (`tool_latest`, refreshed hourly from nodejs.org, the
  mise python list, the npm registry and Muse's channel manifest), so tenants sharing one egress IP
  never spend GitHub's anonymous API quota. The agent always installs an exact version.
- Reconcile never upgrades by itself. Installing missing tools, applying a pin change and removing a
  tool switched off are automatic; moving a `latest`/`lts` tool to a newer release needs an Upgrade.

## Run flow

1. A UI action (`requestReconcile` in `packages/db/src/toolchain.ts`) records the desired change,
   bumps `workspaces.toolchain_generation`, reuses or creates a `toolchain_runs` row and enqueues
   `reconcile_toolchain` (the partial unique index on `jobs` coalesces repeats).
2. Workspace asleep: the handler applies the billing gate, sets `toolchain_pending`, enqueues
   `start_workspace` and parks the run as `waiting`. After the start the worker enqueues the
   reconcile again, and the normal idle policy stops the workspace afterwards. Starting or stopping
   workspaces retry.
3. Running: `buildPlan` diffs desired against observed state, `toAgentStep` turns steps into the
   agent wire format, the agent ships `apply.sh` plus the plan into the container and starts it
   detached. The worker polls `/toolchain/runs/:id`, mirrors log and steps, and settles the rows.
   If the generation moved during the run the worker plans again.
4. `apply.sh` per step: install with each backend in order, smoke test every bin, swap farm links
   atomically, record state, keep current and one previous version. A failure before the swap leaves
   the old links in place (automatic rollback) and removes the partial install. Roll back relinks the
   kept previous version.

Limits: 30 min per run, 10 min per install, 3 attempts after an interruption, quota preflight on the
host (507 when the tenant has under 700 MB free). Error codes: `quota`, `version_not_found`,
`rate_limited`, `integrity`, `timeout`, `smoke_failed`, `missing_bin`, `no_previous`,
`install_failed`.

## Images, manifest and the slim gate

`/opt/agentbox/versions.json` gains `mise`, `toolchainAbi`, `envVersion`, `slim`. After a build the
agent reads it from the exported rootfs and the worker stores it in `images.manifest`.
`--build-arg SLIM=1` (the Slim checkbox on the admin build form) skips the baked Node, Codex, Claude
Code and Oh My Pi layers.

`evaluateImageGate` (`packages/core/src/toolchain/gate.ts`) is enforced by activate, pin, follow and
bulk move in `apps/web/lib/admin/images-ops.ts`:

- a slim image needs, per target workspace: a successful reconcile, no unapplied generation, every
  desired tool managed and not failed, and a mise-bearing manifest;
- any image whose `toolchainAbi` is older than the one a workspace's toolchain was installed under is
  blocked.

The UI lists the blocking workspaces with reasons and a Reconcile now button.

## Rolling out to existing workspaces

1. Deploy control plane (`infra/cp/deploy.sh`; copy `deploy.sh` first if it changed), agent rebuild and
   `infra/host/provision.sh` so the new agent routes exist. Migrations 0008 and 0009 run on worker boot.
2. Build a normal (non-slim) image with the new Containerfile and activate it. It still bakes Node,
   Codex, Claude and omp, so nothing regresses; existing tools show as "from image".
3. `/admin/tools`: Check for updates, then Reconcile all. Sleeping workspaces are started to apply
   (billed as normal awake time); tick "running workspaces only" to avoid that.
4. Build a slim image (`Slim` checked). Activation is blocked until every follower passes the gate.
5. Activate it. Workspaces carry their own toolchain from then on.

Workspaces whose seeded `~/.bashrc` still prepends `~/.local/bin` keep that ahead of the farm; the
farm still precedes the image PATH.

## Not covered

- `fx` has no verified install source and is not in the catalog.
- No maintenance container for sleeping workspaces and no automatic upgrades.
- GitHub token fallback for rate-limited `github:` installs is not implemented: backends fall back to
  the npm package instead.
