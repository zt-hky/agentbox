# AgentBox web design reference

Concept: "Light in the box" (shared with the landing, see `apps/landing/PLAN.md` §2). A workspace is
a dark glass box that lights up when awake and dims when asleep. In the app that becomes an instrument
rack: a workspace is a module with a status light, a name plate and three level meters (CPU, memory,
disk). Night is the setting (dark is the default theme; light and system stay selectable). Source of
truth for tokens: `app/globals.css`. Shared components: `components/`.

## Tokens (light / dark)

| Token (Tailwind)        | Light (Cloud / Ink)   | Dark (Night / Deep)        | Use                                          |
| ----------------------- | --------------------- | -------------------------- | -------------------------------------------- |
| `bg-background`         | `#F4F6FA` Cloud       | `#05070E` Night            | page                                         |
| `bg-card`               | `#FFFFFF`             | `#0C1120` Deep             | panels, inputs                               |
| `bg-sidebar`            | `#FFFFFF`             | `#080C18`                  | sidebar                                      |
| `bg-rack`               | `#EDF0F7`             | `#080C18`                  | recessed areas: meter bay, code, table head  |
| `text-foreground`       | `#0E1324` Ink         | `#E8ECF6`                  | text                                         |
| `bg-primary`, `--ring`  | `#6D5EFC` Iris        | `#6D5EFC` (ring `#8B7FFF`) | primary buttons, focus ring, sidebar primary |
| `text-signal`           | `#5A49EC`             | `#9A8FFF`                  | links, selected nav (Iris tuned for text)    |
| `text-muted-foreground` | `#596380`             | `#A3ADC2` Mist             | secondary text                               |
| `border-border`         | `rgb(14 19 36 / .10)` | `rgb(255 255 255 / .08)`   | hairlines                                    |
| `bg-glass` / `.glass`   | white 72%             | Deep 72%                   | top bar only (blur 20px, saturate 140%)      |

Status lights (state only, never decoration): `status-ok` Aurora (`#12B894` light / `#46E6C3` dark) =
running, ready, done; `status-busy` Ember (`#F0A030` / `#FFB54A`) = starting, stopping, provisioning,
pending; `status-error` `#FF5C70`; `status-idle` Mist (`#8D97AD` / `#A3ADC2`) = sleeping, queued.
`text-destructive` is a deeper red in light (`#D12C45`) for text contrast. Charts: `--chart-1` Iris,
`--chart-2` Aurora, `--chart-3` Ember. Iris → Aurora gradient exists only in the logo and the auth
box light.

## Type

- Be Vietnam Pro (`font-sans`, default; weights 400/500/600/700; latin, latin-ext and vietnamese
  subsets) for everything; JetBrains Mono (`font-mono`, or `<Mono>`) only for machine text: slugs as
  hostnames, image IDs, ports, UIDs, commands, logs, process lists.
- Scale: `text-xs` 12, `text-meta` 13, `text-sm` 14, `text-base` 16, `text-xl` 20, `text-title` 28,
  `text-display` 36. Headings are 600 with -0.02em tracking (applied to h1-h3 globally).
- Avoid global `tabular-nums` (it widens decimal points); use it only on integer-only columns.

## Shape and motion

- Radius: `rounded-xl` 28px workspace hero module only, `rounded-lg` 18px panels/cards/tables,
  `rounded-md` 12px controls, `rounded-sm` 6px square badges. Pills (`rounded-full`) for status.
- Hairline borders, no shadows, except `shadow-module` on the hero module. Glass only on the sticky
  top bar (`.glass`); no glows in tables or lists. The one glow: the running hero status light and the
  AgentBox object on the auth pages.
- Login and request-access are always Night (`dark` wrapper + `.night-backdrop`) regardless of the theme
  choice, with the static AgentBox object (`AuthShell`). The onboarding wizard is not Night: it uses
  the app's `bg-background`/`bg-card` surfaces, hairline borders and Iris, in the user's theme.
- No continuous animation, with one exception (below). A `StatusLight` pulses once when its status
  changes (CSS, keyed remount). `prefers-reduced-motion` disables all animation/transition globally.
- **Motion exception.** Rich animation is allowed only in (1) the onboarding wizard, above all the
  workspace-creation screen, and (2) tool install, remove and upgrade progress on `/tools`. The
  language is "blocks linking into a chain": `Chain` blocks reveal with a stagger, the link into the
  active block flows, the active block pulses, `HashTicker` mono text ticks, `ChainBar` sweeps.
  Rules: it runs only while the operation is in progress (no item `active` means nothing moves);
  it uses the app tokens (Iris `primary`/`signal` for active and done blocks, links and the sweep;
  `status-error` for failure; mono for hashes);
  the global reduced-motion rule applies and `HashTicker` also checks it. Styles live under
  `chain-*` in `globals.css`. Nowhere else: dashboard, tables, admin stay static.

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
- `PlanCard({ plan, sub, balanceMicro, prices, label, creditValueVnd, now, showRates? })` the user's plan: trial and daily countdown (`lib/plan-status.ts`), included runtime left, credit rates, balance. `PlansComparison({ plans, currentPlanId, label, creditValueVnd })` public plans side by side with an "Ask an admin to upgrade" note (no payment integration). Money is always `formatCredits(micro, label, creditValueVnd)`: "139 credits (139.000 ₫)".
- `EmptyState({ title, description?, action? })` dashed panel; always say what to do next.
- `Chain({ items: { key, label, detail?, state: "pending"|"active"|"done"|"failed" }[], orientation? })`, `ChainBar({ value 0..1, active, label })`, `HashTicker({ active, settled?, length? })` **client**: the motion-exception components; use only where the exception allows.
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
- `Logo` (isometric box mark with Iris → Aurora top slot), `AuthShell` (Night login/waiting frame with the AgentBox object) for public pages.
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
- No gradient washes, no fade-in on sections, no looping animation outside the motion exception, no shadows beyond the hero module.
- No per-use `className` overrides on `components/ui/*` to change look; no new colours outside the tokens.
- No raw hex in pages; use tokens. No `Progress` for levels; use `Meter`.
