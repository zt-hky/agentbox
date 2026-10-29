# AgentBox web design reference

Concept: an instrument rack. A workspace is a module with a status light, a name plate and three
level meters (CPU, memory, disk). The module is the one memorable element; everything around it
stays quiet. Source of truth for tokens: `app/globals.css`. Shared components: `components/`.

## Tokens (light / dark)

| Token (Tailwind)                 | Light                                   | Dark      | Use                                         |
| -------------------------------- | --------------------------------------- | --------- | ------------------------------------------- |
| `bg-background` (paper)          | `#F4F5F3`                               | `#151918` | page                                        |
| `bg-card` (panel)                | `#FFFFFF`                               | `#1C2120` | panels, inputs, sidebar                     |
| `bg-rack`                        | `#EEF0EE`                               | `#171C1B` | recessed areas: meter bay, code, table head |
| `text-foreground` / `bg-primary` | `#1A1E1C`                               | `#E9ECEA` | text, primary buttons                       |
| `border-border`                  | `#D8DCD9`                               | `#2C3331` | hairlines                                   |
| `text-muted-foreground`          | `#5E6662`                               | `#97A09B` | secondary text                              |
| `text-signal` / `bg-signal`      | `#0E7C6B`                               | `#3FC3AA` | focus ring, links, selected nav, chart-1    |
| `status-ok/busy/error/idle`      | `#2FA866` `#D9961A` `#D9443F` `#8A938E` | same      | state only, never decoration                |

`text-destructive` is a darker red (`#C23631` / `#EE6A65`) for text contrast; the status lights use
the brief's exact reds. Charts: `--chart-1` signal, `--chart-2` slate blue, `--chart-3` amber.

## Type

- Schibsted Grotesk (`font-sans`, default) for everything; JetBrains Mono (`font-mono`, or `<Mono>`)
  only for machine text: slugs as hostnames, image IDs, ports, UIDs, commands, logs, process lists.
- Scale: `text-xs` 12, `text-meta` 13, `text-sm` 14, `text-base` 16, `text-xl` 20, `text-title` 28,
  `text-display` 36. Headings are 600 with negative tracking (applied to h1-h3 globally).
- Schibsted's tabular figures widen the decimal point and comma visibly, so `tabular-nums` is not applied
  globally; use it only on integer-only columns (counts, ports) where alignment matters.

## Shape and motion

- Radius: `rounded-xl` 14px workspace module only, `rounded-lg` 10px panels/cards/tables,
  `rounded-md` 7px controls, `rounded-sm` 5px square badges. Pills (`rounded-full`) only for status.
- Hairline borders, no shadows, except `shadow-module` on the hero module.
- No continuous animation. A `StatusLight` pulses once when its status changes (CSS, keyed remount).
  `prefers-reduced-motion` disables all animation/transition globally.

## Layout

`AppShell` (flat sidebar, slim header, content `max-w-[1200px]`, `gap-8`). Every page starts with
`PageHeader`. Sections are `Section` panels only when the block needs a heading. Admin nav groups
live in `components/nav-config.ts` (`ADMIN_NAV_GROUPS`: People, Workspaces, Platform, Billing).

## Components (all server-friendly unless marked client)

- `PageHeader({ title, description?, actions? })` page h1 (28px) + one-line description + right-side actions.
- `Section({ title, description?, actions?, children, className?, bodyClassName? })` titled panel; use
  `bodyClassName="p-0"` with `<DataTable flush>` for edge-to-edge tables.
- `StatusLight({ status, size?: "sm"|"md"|"lg", label?, className? })` lamp for any status string
  (workspace, job, image, access). Helpers: `statusTone`, `statusLabel`, `describeWorkspaceStatus`.
- `StatusBadge({ status, label? })` pill = lamp + sentence-case word. Use for tables and headers.
- `Meter({ label, value: number|null, max, format?: (v, max) => string, compact?, tone?: "auto"|"signal" })`
  20-segment level meter, `role="meter"`. Amber from 75%, red from 90% (`tone="signal"` disables).
  `compact` = bar + readout, for table cells. `value=null` shows "no data".
- `WorkspaceModule({ ws, variant: "hero"|"row", live?, limits?, host?, stateText?, actions?, href?, now?, className? })`
  - `ws`: `{ slug, status, owner?, plan?, lastActivityAt?, awakeSince? }`
  - `live`: `{ cpuCores, memBytes, diskBytes }` (each may be null); shown only while `status === "running"`
  - `limits`: `{ cpus, memBytes, diskBytes }` plan limits that scale the meters
  - hero: large plate with state sentence and `actions`; row: admin list row, `href` makes the whole row a link
    (actions stay clickable). Pass `now` for deterministic relative times in tests.
- `Stat({ label, value, hint?, className? })` small metric; use sparingly.
- `EmptyState({ title, description?, action? })` dashed panel; always say what to do next.
- `Mono({ children, className? })` inline JetBrains Mono.
- `KeyValueList({ items: { label, value: ReactNode, mono? }[] })` technical properties.
- `CodeBlock({ text, wrap?, maxHeight?, label? })` scrollable mono block with copy button (`CopyButton` is the client part).
- `Timeline({ items: { id?, title, time, detail?, status? }[] })` events; `status` colours the lamp.
- `Notice({ tone?: "info"|"error", children })` inline message (what happened, how to fix it).
- `ConfirmDialog({ trigger, title, description, confirmLabel?, destructive?, confirmText?, onConfirm })` **client**.
  `trigger` is one button element. `confirmText="slug"` requires typing it to enable the button. `onConfirm` may
  return a server-action `ActionResult`; on `{ ok: false }` the dialog stays open showing the error.
- `AllowanceMeters({ used, plan })` three plan-allowance meters (runtime, CPU, memory).
- `DataTable({ columns, data, empty?, flush? })` **client**, restyled; `UsageChart({ data, endDate })` **client**.
- `Logo`, `AuthShell` (login/waiting frame) for public pages.
- Primitives in `components/ui/*` are restyled via tokens/variants. `Badge` has a `status` variant (pill); the
  default badge is a 5px-radius tag. Do not override primitives per use; add a variant instead.

Live data helpers: `lib/live-stats.ts` (`readingFromHostStats`, `cpuCoresFromSample`), `lib/format.ts`
(`formatAgo`, `formatDuration`, `formatBytes`, `formatDateTime`).

## Do

- Sentence case, plain active voice, English. Empty states say what to do next; errors say how to fix.
- Use status lights/badges for state only, with a word beside the colour.
- Use `Mono` for hostnames, IDs, ports, paths, commands.
- Keep content left-aligned; vary layout (meters, key-value lists, tables) instead of card grids.

## Don't

- No ALL-CAPS eyebrow labels, no middle-dot joined meta strings, no "→" on buttons/links.
- No gradient washes, no fade-in on sections, no looping animation, no shadows beyond the hero module.
- No per-use `className` overrides on `components/ui/*` to change look; no new colours outside the tokens.
- No raw hex in pages; use tokens. No `Progress` for levels; use `Meter`.
