# AgentBox

Multi-tenant coding-agent SaaS on rootless Podman.

## Layout

- `apps/web` — Next.js user/admin UI (better-auth)
- `apps/worker` — gateway-auth server, job runner, metering and billing loops
- `apps/agent` — host root daemon (unix socket, Node 22 APIs only)
- `packages/core` — pure shared logic (hosts, slots, identity, tokens, billing, idle, agent API, settings)
- `packages/db` — Drizzle schema, migrations, client
- `images/workspace` — workspace image
- `infra/` — host provisioning, control-plane deployment
- `docs/security/` — sandbox docs and host validation

## Tests

```sh
pnpm install
pnpm -r test        # Vitest across all packages
pnpm -r typecheck
pnpm lint
```

## Deviations

- The plan says pnpm 10; the installed pnpm is 12.14.0, so `packageManager` is `pnpm@12.14.0`.
- TypeScript pinned to 6.0.3: typescript-eslint 8.72.1 rejects TS 7.
