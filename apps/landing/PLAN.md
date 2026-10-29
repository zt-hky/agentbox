# AgentBox landing + brand plan

Research inputs (read them; they are the evidence behind every decision here):
`local://landing-research-apple.md`, `local://landing-research-ai-crypto.md`, screenshots in
`/tmp/landing-research/{apple,ai-crypto}/`, licensed photos in `/tmp/landing-research/images/` (+ `SOURCES.md`).

## 1. What the research says (the short version)

- Apple product pages are one machine: a real object + one sentence + one CTA in the first view; a sticky
  local nav with a buy pill; ~3 viewport heights per feature story; native `position: sticky` stages with
  0.7–1.5 vh of dwell; small entrance travel (a few tens of px + fade, 0.16–0.32 s); two-tone paragraphs
  (dark lead clause, grey rest); stats as big static numerals under a hairline; a highlights carousel with a
  progress-pill pager; a compare table near the end. Display type 600 weight, tight tracking (-0.015em at
  80–96 px), line-height ~1.05, halved on phones; dark/light zone rhythm (iPhone Pro: black/#1d1d1f).
- The memorable AI/crypto pages commit to one recognisable move each: E2B's live terminal with a ticking
  uptime, Solana's glass shader, Cursor's painterly backdrop under real windows, Codespaces' browser frame
  showing the real subdomain. None of them uses padlocks: isolation is explained with small labelled UI
  scenes (egress allow/deny rows, port → URL lines).
- Avoid: fake prompt boxes (AgentBox is invite-only), text-only first view, invented logos/numbers,
  enterprise vocabulary, pastel blobs, heavy WebGL that is off-screen on phones, scroll hijacking that
  fights native scroll, pins longer than ~3 vh.

## 2. Brand system (shared by the landing and the app)

Concept: **"Light in the box."** A workspace is a dark glass box that lights up when it is awake and dims
when it sleeps. Night is the setting (developers work late; the photography is night cities, Saigon river,
aurora); light is the product. This gives one memorable move: the glowing AgentBox object.

Palette (named, hex):
| Token | Hex | Role |
|---|---|---|
| Night | `#05070E` | page base in dark zones (deliberately blue-black, the night sky, not a grey) |
| Deep | `#0C1120` | raised panels on Night |
| Iris | `#6D5EFC` | brand primary: CTAs, links, the box's core light, focus ring |
| Aurora | `#46E6C3` | "awake/running" light, live data, success |
| Ember | `#FFB54A` | warmth: city light, "waking/starting", rare highlights (≤3 uses per page) |
| Cloud | `#F4F6FA` | light zones (pricing, FAQ) and light-mode app background |
| Ink | `#0E1324` | text on Cloud; Mist `#A3ADC2` = secondary text on Night (≥4.5:1) |
Why this is on trend for the category without being a template: AI tools 2025–26 converge on deep
night bases with an electric violet-blue (Linear, Codex, Solana) — Iris places AgentBox in that family;
Aurora (a cool mint) carries the "it's alive" status meaning that a sandbox product needs and that
competitors use as their whole identity (Codespaces green, E2B red) — here it is a state colour, not the
brand; Ember is the local, human counterpoint (Saigon street light) nobody in the category uses.
Gradient (only on the box light and the primary CTA hover): Iris → Aurora at 135°.
Errors: `#FF5C70`. Hairlines: `rgba(255,255,255,0.08)` on Night, `rgba(14,19,36,0.10)` on Cloud.

Type:
- **Be Vietnam Pro** (variable, Google Fonts, self-hosted subset incl. Vietnamese): a geometric-grotesk
  in the SF Pro spirit, designed in Vietnam — a quiet signal of where AgentBox is built and ready for a
  Vietnamese edition. Display 600, tracking -0.02em at ≥64 px, -0.012em at 40–56 px; body 400/500.
- **JetBrains Mono** only for machine text (terminal, hostnames, ports, commands) and bracket labels.
- Scale (desktop / phone): hero 96/48, scene 80/40, section 56/32, lede 24/19, body 19/17, small 14/13,
  label (mono) 13/12. Line-height 1.04 on display, 1.45 on body. Hand-broken headlines, ending with a period.

Shape & depth: radius 28 px (stage cards), 18 (cards), 12 (controls), 999 (pills). Glass = `Deep` at 72%
+ `backdrop-filter: blur(20px) saturate(140%)` + 1 px hairline. One glow per scene, never stacked.

Logo: an isometric box drawn with three faces; the top face is a slot of Iris→Aurora light. Wordmark
"AgentBox" in Be Vietnam Pro 600, -0.02em. Delivered as SVG (mark, wordmark, favicon, OG image).

## 3. Story and sections (≈16 vh desktop, same beats on phone)

Copy is English (matches the app; the font already supports Vietnamese for a later VI edition).
Every claim must be a real AgentBox fact (see README / security doc). No invented logos or numbers.

0. **Nav**: floating glass pill — mark + "AgentBox", anchors (How it works, Security, Pricing, FAQ),
   "Sign in" (text) and "Request access" (Iris pill). After the hero it contracts; on phones: mark +
   Request access pill + menu button. A sticky bottom pill "Request access" appears after the hero on phones.
1. **Hero** (Night, 1.6 vh with a 0.6 vh scrub): eyebrow `[ AGENTBOX ]`, H1 "Every agent deserves a
   machine of its own." Lede (two-tone): "**Your own cloud workspace,** with T3 Code, VS Code, Claude Code,
   Codex and Oh My Pi ready in any browser." CTAs: Request access · See how it works. Visual: the
   **AgentBox object** (SVG/CSS 3D glass box) with its light off; on load the light boots (one orchestrated
   1.6 s sequence), and a terminal card types `open maple` → `waking… 3.2 s` → `running · uptime 00:00:41`
   (ticking). Scrolling tilts the box and lifts its lid: the windows of the next section rise out of it.
2. **Surfaces row**: six tiles (T3 Code, VS Code, Claude Code, Codex, Oh My Pi, GitHub) with real icons
   drawn as simple monochrome glyphs; hover lifts 2 px.
3. **"Your machine, assembled"** (pinned 2.6 vh, the Apple exploded-hardware scene): an isometric stack
   assembles layer by layer while the left column steps through: read-only system (Ubuntu) → your own
   Linux user → rootless container → the tools → your files in `/workspace` → its own address
   `maple-t3.agentbox.io.vn`. Final frame: the closed, glowing box with the hostname label.
4. **"Any browser. Any device."** (Night over the Saigon river photo, parallax): a browser frame with
   `maple-code.agentbox.io.vn` showing VS Code, overlapped by a phone frame showing T3 Code (Cursor's
   overlapping windows + Codespaces' URL). Two-tone paragraph: no install, no pairing, sign in once.
5. **Marquee break**: giant outlined/solid words "YOUR MACHINE · YOUR AGENTS · ANY BROWSER" moving with scroll
   velocity (the one place we use all caps).
6. **Security** (pinned 2.2 vh, AirPods ring scene): concentric light rings expand around the box;
   labelled packets (LAN 192.168.x, VPN 100.x, cloud metadata, other workspaces) fly toward it and are
   stopped at the ring; H2 "Nothing gets in. Nothing gets out." Then a **bento of six tiny UI scenes**:
   no root (`uid=1000`), every capability dropped (`CapEff 0`), read-only system, firewall table
   (allow internet / deny LAN, VPN, metadata, tenants), resource meters (CPU/RAM/processes), disk quota.
7. **Sleep & wake** (aurora photo, 1.6 vh): the box dims to a sleeping state as you scroll, a moon arc
   passes, then it wakes; hairline stat row: "Sleeps when idle." "Wakes in seconds." "Your files stay."
8. **Highlights carousel** (Apple pager, Night): six cards with real UI (drawn in DOM/SVG): Oh My Pi signs
   in to 85 model services · GitHub in one click · live usage meters · sessions you can revoke · a
   dashboard that tells you what's left · works on a phone. Autoplay with progress pill + pause.
9. **Pricing** (Cloud zone): H2 "Pay for what you run." Three columns from the live plans (Free / Pay as
   you go / Pro): limits, monthly allowance, price in credits; metered on runtime, CPU and memory; one CTA
   each ("Request access"). Values are generated at build time from the production DB (fallback JSON).
10. **FAQ** (Cloud): 6–8 honest answers (what runs inside, where it is hosted, what happens when idle,
    security model, billing, how to get access, data).
11. **Final CTA** (Night over the Saigon skyline): "Your machine is waiting." Request access · Sign in.
12. **Footer**: mark, links (Sign in, Status? no — only real links), photo credits (Unsplash/Pexels names).

## 4. Motion system

- Libraries: **GSAP 3 + ScrollTrigger + SplitText** (scrubbed pinned scenes, line reveals) and **Lenis**
  (smooth scroll, desktop fine-pointer only, synced to ScrollTrigger). CSS for hovers and the marquee base.
- Rules: animate only `transform`, `opacity`, `filter: blur()` (≤8 px) and SVG stroke/opacity; entrance
  = 24 px rise + fade, 0.6 s `power3.out`, staggered 0.06 s by line; scrubbed scenes use `scrub: 0.6`.
  Pin dwell ≤ 1.5 vh per beat. One orchestrated load moment (hero box boot). No infinite loops except the
  terminal cursor and uptime digits; the marquee only moves while scrolling; every autoplay has a pause.
- `prefers-reduced-motion`: Lenis off, no pins/scrubs (scenes show their final frame), reveals become
  instant, carousel does not autoplay. Same content in the same order.
- Phones (coarse pointer / < 768 px): pins kept only for the assembly scene (shortened to 1.6 vh); the
  security rings play once on enter; parallax off; images use portrait crops.

## 5. Illustrations (hand-built SVG, art direction)

Isometric, 30° projection; strokes 1.25 px Mist at 40%; faces filled with Deep→Night gradients; light
comes only from Iris/Aurora slots and edges (gaussian glow ≤ 12 px). Set: the AgentBox object (lid,
4 faces, light slot, hostname plate), the 6 assembly layers, security rings + packet glyphs, bento mini
scenes, sleep moon/arc, browser + phone frames, surface glyphs, logo. Every animated part has a stable id.

## 6. Photography

From `/tmp/landing-research/images/` (licences verified): 14 (Saigon river, final CTA), 15 (Saigon
portrait crop, phone final CTA), 13 (aurora, sleep & wake), 02/03 (glow + hands, browser scene backdrop
alternates), 12 (smoke texture, security backdrop at 12% opacity). Graded to the palette (darken, cool),
encoded AVIF + WebP + JPEG at 640/1280/2048 widths, lazy except none above the fold. Credits in footer.

## 7. Tech, performance, accessibility

- `apps/landing`: Vite + TypeScript, no framework (static HTML sections + small TS modules per scene).
  Build → static `dist/` served by Caddy at `https://agentbox.io.vn/` (replaces today's redirect);
  `app.` stays the app. OG image + meta + favicon.
- Budget: JS ≤ 110 KB gz, CSS ≤ 40 KB gz, LCP ≤ 2.5 s (hero is SVG/CSS, fonts preloaded, subset),
  CLS 0, no layout animation, images lazy with explicit sizes. Lighthouse ≥ 90 performance on mobile.
- A11y: semantic landmarks, headings in order, 4.5:1 contrast, visible focus, keyboard-operable
  carousel/FAQ, pause controls, `alt` on photos, decorative SVG `aria-hidden`.

## 8. App re-theme (after the landing is approved by QA)

Map the brand tokens onto the app's shadcn variables: primary/ring = Iris, running light = Aurora,
starting = Ember, error = `#FF5C70`; dark default = Night/Deep, light = Cloud/Ink; fonts → Be Vietnam Pro +
JetBrains Mono; new logo; login and request-access pages reuse the hero box (static, small) and the night
backdrop. Keep the rack/module structure and every behaviour; update `apps/web/DESIGN.md`.

## 9. QA and done

Screenshots at 1440, 1024, 390 (dark sections and light), mid-scroll frames of each pinned scene,
reduced-motion pass, Lighthouse mobile + desktop, real-device-sized check of tap targets, links to the
app work, then deploy behind Caddy and verify `https://agentbox.io.vn/` publicly.
