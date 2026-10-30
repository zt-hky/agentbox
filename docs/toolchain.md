# Per-workspace toolchain

Runtimes (Node, Bun, Python, Rust, Go, Java) and agent CLIs (Claude Code, Codex, Oh My Pi, Pi, OpenCode, Grok, Muse,
GitHub Copilot CLI) are installed per workspace under `/workspace/home`, not baked into the shared
image. The image is always slim: it keeps only what every workspace needs to boot (apt tools, git,
`gh`, `uv`, `mise`, code-server, the T3 server, the resource monitor and `workspace-init`) and bakes
no Node, agent CLI or other language runtime. See [`images.md`](images.md) for how images are built
and numbered, and [`onboarding.md`](onboarding.md) for how users pick their tools.

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

- Default for every tool is `latest`; Node's and Java's default channel is `lts`.
- Package managers are catalog entries of kind `package-manager` with a `requires` language: pnpm
  (`aqua:pnpm/pnpm`, then `npm:pnpm`) and Yarn 4 (`aqua:yarnpkg/berry`, then `npm:@yarnpkg/cli-dist`) on
  Node, uv (`aqua:astral-sh/uv`) and Poetry (`pypi:poetry`, installed by uv) on Python, Maven
  (`aqua:apache/maven`) and Gradle (`aqua:gradle/gradle-distributions`) on Java. They go through the
  same plan/apply/remove/upgrade path, are ordered after the runtimes, are skipped while their language
  is not wanted, and the Tools page and server refuse to install one without its language. Their versions
  come from the npm registry, GitHub releases (uv, Gradle), PyPI and Maven Central metadata. npm, pip,
  Cargo and Go modules ship with their language and are not catalog tools.
- Rust (`rust`), Go (`go`) and Java (`java`, OpenJDK) install through their mise core backends. Their
  versions come from GitHub releases (`rust-lang/rust`), `go.dev/dl` and the Adoptium API (Java
  versions below 17 are not offered; Java's LTS channel is the newest LTS release).
- Node, Python, Rust, Go and Java also offer older `major.minor` lines. A line resolves to the newest patch published
  in it. The server rejects any other pin for those tools. Bun and agent CLIs pin an exact version
  from the recent published list.
- Versions are resolved centrally by the worker (`tool_latest`, refreshed hourly from nodejs.org, the
  mise python list, go.dev, the Adoptium API, GitHub releases for Rust, the npm registry and Muse's
  channel manifest), so tenants sharing one egress IP
  never spend GitHub's anonymous API quota. The agent always installs an exact version.
- Reconcile never upgrades by itself. Installing missing tools, applying a pin change and removing a
  tool switched off are automatic; moving a `latest`/`lts` tool to a newer release needs an Upgrade.

## mise registry tools (any tool or language beyond the catalog)

Users can add any tool from the mise registry, in onboarding step 1a ("Search more tools from the
mise registry") and on `/tools` ("Other tools" > search). They go through the same plan, apply,
remove and reinstall path as catalog tools.

- **Snapshot.** `packages/core/src/toolchain/mise-registry.json` is generated, committed, and lists
  `{ name, backends, aliases?, description? }` for the mise version the image pins
  (`images/workspace/Containerfile`, `MISE_VERSION`). Curated catalog tools are left out (by id,
  alias or shared backend), and so are backends the agent's `backendSpecSchema` cannot pass through
  (asdf git URLs). It is not fetched at runtime and is never edited by hand.
- **Regenerating when the image's mise is bumped.** Bump `MISE_VERSION`, then run
  `node packages/core/scripts/gen-mise-registry.ts` (Node 22.18+; it reads the version from the
  Containerfile, or take it as the first argument). The script downloads that release's linux-x64
  tarball into a temp dir, runs `mise registry --json --hide-aliased` and rewrites the JSON. Commit
  the diff: a name that vanished from the registry makes `mise:<name>` ids that users already saved
  invalid (they are dropped from selections and ignored by planning), so read the diff for removals.
- **Ids.** `mise:<name>` (`^mise:[a-z0-9][a-z0-9._-]{0,63}$`, and the name must be in the snapshot);
  `toolIdSchema` accepts curated ids and these, so action inputs, plan steps and agent steps all
  validate them. `workspace_tools.tool_id` is plain text: no migration. Admin defaults and the
  disabled list stay curated-only (`curatedToolIdSchema`). At most `REGISTRY_TOOL_LIMIT` (16) per user.
- **Install.** Backend is the snapshot's first backend (no fallback). Channels are `latest` and `pin`;
  a pin is user-typed (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, a prefix such as `3.12` is allowed).
  There is no version source: no update check and no "update available". Reconcile never reinstalls
  by itself; Upgrade (planner) and Reinstall (UI) reinstall `latest`, a pin is left alone. The plan
  step carries `to: "latest"` or the pin, and the agent resolves it with `mise latest <spec>[@pin]`
  and records that exact version; no previous version is kept (no rollback).
- **Bins are discovered.** Registry steps have `registry: true` and no `bins`. `apply.sh` links every
  executable of the install's `bin/` (or of the install root when it has no `bin/`) into the PATH
  farm and stores the names in `toolchain.json`; remove deletes exactly those links. A name already
  linked by another tool fails the step (`<name> is already linked by <tool>`) and nothing is
  swapped. The smoke test is "at least one executable was linked": no `--version` call. The size
  hint is unknown (`sizeHintMb: null`); the measured size is recorded after install.
- **Search.** Server action `searchMiseTools(query)` (`apps/web/app/registry-actions.ts`,
  `requireActiveUser`): top 20 `{ id, name, backend, description }`, name/alias prefix matches first,
  then substring matches; an empty query returns nothing.
- **Versions.** `registryVersionSource(id)` derives a source from the first backend that has one:
  `aqua:`/`github:`/`ubi:` `owner/repo` -> GitHub releases (a `v` or `<name>-` tag prefix is stripped),
  `npm:`, `pipx:`/`pypi:`, `cargo:` (crates.io) and `go:github.com/o/r` (module proxy); core, asdf,
  vfox, http, conda and the rest have none (free-text version only). Server action
  `registryToolVersions(id)` returns up to 50 stable versions newest first, cached in `tool_latest`
  under the `mise:<name>` id for the hourly TTL and refreshed only on demand (registry tools are not in
  the worker's refresh loop; a failed fetch is not retried for 60s). Failures and sourceless tools give
  an empty list, so the select offers just `Latest` and `Other version…` (text input). 919 of the 998
  snapshot entries have a source.
- Tested by `apps/agent/test/apply-registry.test.ts` (real `apply.sh` against a fake `mise` shim in a
  temporary HOME), plus the core, web and worker toolchain tests.

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

`/opt/agentbox/versions.json` carries `mise`, `toolchainAbi`, `envVersion` and `slim` (always `true`
for images built now). After a build the agent reads it from the exported rootfs and the worker stores
it in `images.manifest`. Images built before slim-only builds may still bake Node, Codex, Claude Code
and Oh My Pi; the gate below keeps workspaces from moving off them before their toolchain is ready.

`evaluateImageGate` (`packages/core/src/toolchain/gate.ts`) is enforced by activate, pin, follow and
bulk move in `apps/web/lib/admin/images-ops.ts`:

- a slim image needs, per target workspace: a successful reconcile, no unapplied generation, every
  desired tool managed and not failed, and a mise-bearing manifest;
- any image whose `toolchainAbi` is older than the one a workspace's toolchain was installed under is
  blocked.

The UI lists the blocking workspaces with reasons and a Reconcile now button.

## Rolling out to existing workspaces

1. Deploy control plane (`infra/cp/deploy.sh`; copy `deploy.sh` first if it changed), agent rebuild and
   `infra/host/provision.sh` so the new agent routes exist. Migrations run on worker boot.
2. Build a slim image (docs/images.md) and keep the old image active for now. Existing tools show as
   "from image" until a managed copy replaces them.
3. `/admin/tools`: Check for updates, then Reconcile all. Sleeping workspaces are started to apply
   (billed as normal awake time); tick "running workspaces only" to avoid that.
4. Activation of the new image is blocked until every follower passes the gate.
5. Activate it. Workspaces carry their own toolchain from then on.

Workspaces whose seeded `~/.bashrc` still prepends `~/.local/bin` keep that ahead of the farm; the
farm still precedes the image PATH.

## Not covered

- `fx` has no verified install source and is not in the curated catalog (it may exist in the mise registry).
- Registry tools are only linked by what `bin/` contains: tools that need `mise exec`, shims or env setup beyond the executables are not supported, and registry installs are not verified against a real container (only the fake-shim test and the pinned mise's registry listing).
- No maintenance container for sleeping workspaces and no automatic upgrades.
- GitHub token fallback for rate-limited `github:` installs is not implemented: backends fall back to
  the npm package instead.
