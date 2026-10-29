import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

interface Plan {
  name: string;
  kind: string;
  monthlyPriceMicro: number;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  inodes: number;
  pids: number;
  trialDays: number | null;
  dailyRuntimeHours: number | null;
  maxAwakeHours: number | null;
  idleTimeoutMinutes: number | null;
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
}
interface PlansFile {
  creditLabel: string;
  creditValueVnd: number;
  prices: { runtimePerHour: number; cpuCorePerHour: number; memGbPerHour: number };
  plans: Plan[];
}

const APP_LOGIN = "https://app.agentbox.io.vn/login";
const photoDims: Record<string, [number, number]> = {
  saigon: [2048, 1152],
  "saigon-portrait": [2048, 2887],
  aurora: [2000, 3000],
  "aurora-wide": [2000, 1250],
  smoke: [2048, 1152],
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

function art(name: string, attrs: string): string {
  const file = here(`./src/art/${name}.svg`);
  if (!existsSync(file)) {
    console.warn(`[landing] art not found yet, using placeholder: ${name}`);
    return `<svg viewBox="0 0 800 800" aria-hidden="true" focusable="false" ${attrs}><rect x="200" y="200" width="400" height="400" rx="24" fill="#0C1120" stroke="#6D5EFC" stroke-opacity=".4"/></svg>`;
  }
  const svg = readFileSync(file, "utf8")
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .trim();
  return svg.replace(/<svg\b([^>]*)>/, (_m, a: string) => {
    const clean = a.replace(/\s(width|height|aria-hidden|class)="[^"]*"/g, "");
    return `<svg${clean} aria-hidden="true" focusable="false" ${attrs}>`;
  });
}

function picture(spec: string): string {
  // name|mobileName|alt|class|sizes|eager
  const [name = "", mobile = "", alt = "", cls = "", sizes = "100vw", eager = ""] = spec.split("|");
  const dim = photoDims[name];
  if (!dim) throw new Error(`unknown photo ${name}`);
  const set = (n: string, ext: string) =>
    [640, 1280, 2048]
      .map((w) => `/img/${n}-${w}.${ext} ${Math.min(w, photoDims[n]![0])}w`)
      .join(", ");
  const sources = (n: string, media: string) =>
    (["avif", "webp"] as const)
      .map((e) => `<source ${media}type="image/${e}" srcset="${set(n, e)}" sizes="${sizes}">`)
      .join("");
  const m = mobile ? sources(mobile, 'media="(max-width: 767px)" ') : "";
  return `<picture class="${cls}">${m}${sources(name, "")}<img src="/img/${name}-1280.jpg" srcset="${set(name, "jpg")}" sizes="${sizes}" width="${dim[0]}" height="${dim[1]}" alt="${esc(alt)}" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'}></picture>`;
}

function plansHtml(): string {
  const data = JSON.parse(readFileSync(here("./src/data/plans.json"), "utf8")) as PlansFile;
  const label = data.creditLabel;
  const vndPerCredit = data.creditValueVnd;
  const vnd = (n: number) =>
    `${Math.round(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
  const creditsOf = (micro: number) => micro / 1_000_000;
  const credits = (v: number) => `${num(v)} ${label}${v === 1 ? "" : "s"}`;
  const hours = (h: number) => `${num(h)} h`;
  const mins = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  const mem = (mb: number) => (mb >= 1024 ? `${num(mb / 1024)} GB` : `${mb} MB`);
  const cards = data.plans
    .map((p, i) => {
      const monthly = creditsOf(p.monthlyPriceMicro);
      const trial = p.trialDays !== null;
      const feature = p.kind === "package" && i === 1;
      const tagline = trial
        ? "Try a full workspace before you pay."
        : feature
          ? "A workspace for steady daily work."
          : "Room for heavier agents.";
      const price = monthly > 0 ? vnd(monthly * vndPerCredit) : "0 ₫";
      const per = trial ? `for ${p.trialDays} days` : `per month · ${credits(monthly)}`;
      const perDay = num(Math.round((p.allowanceRuntimeHours / 30) * 2) / 2);
      const rows: [string, string][] = [
        ["vCPU", num(p.cpu)],
        ["Memory", mem(p.memoryMb)],
        ["Disk", `${num(p.diskGb)} GB`],
        [
          "Included runtime",
          trial
            ? `${hours(p.allowanceRuntimeHours)} in total`
            : `${hours(p.allowanceRuntimeHours)} a month`,
        ],
        trial && p.dailyRuntimeHours !== null
          ? ["Daily cap", `${hours(p.dailyRuntimeHours)} a day`]
          : ["That is about", `${perDay} h a day`],
        ["Extra runtime", trial ? "none during trial" : "billed in credits"],
        [
          "Sleeps when idle",
          p.idleTimeoutMinutes !== null ? mins(p.idleTimeoutMinutes) : "default",
        ],
        ["Max awake at once", p.maxAwakeHours !== null ? hours(p.maxAwakeHours) : "default"],
      ];
      const list = rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");
      const cta = trial ? "Request access" : `Request access for ${esc(p.name)}`;
      return `<article class="plan${feature ? " is-feature" : ""}">
  ${feature ? '<p class="plan-flag mono">[ RECOMMENDED ]</p>' : ""}
  <h3>${esc(p.name)}</h3>
  <p class="plan-tag">${esc(tagline)}</p>
  <p class="plan-price"><span>${esc(price)}</span><small>${esc(per)}</small></p>
  <ul class="plan-limits">${list}</ul>
  <a class="btn btn-${feature ? "primary" : "ghost"}" href="${APP_LOGIN}">${cta}</a>
</article>`;
    })
    .join("\n");
  const r = data.prices;
  const rate = (m: number) => vnd((m / 1_000_000) * vndPerCredit);
  const extra = `<div class="extra">
  <div class="extra-head">
    <p class="mono extra-eyebrow">[ EXTRA USAGE WITH CREDITS ]</p>
    <p class="extra-note">Past your included hours, usage is metered every minute and drawn from your credit balance. 1 ${esc(label)} = ${vnd(vndPerCredit)}. After the trial, a workspace runs on credits alone.</p>
  </div>
  <dl class="extra-rates">
    <div><dt>Runtime</dt><dd>${rate(r.runtimePerHour)}<small>per hour</small></dd></div>
    <div><dt>CPU</dt><dd>${rate(r.cpuCorePerHour)}<small>per core-hour</small></dd></div>
    <div><dt>Memory</dt><dd>${rate(r.memGbPerHour)}<small>per GB-hour</small></dd></div>
  </dl>
</div>`;
  return `<div class="plans">${cards}</div>${extra}`;
}

function agentboxHtml(): Plugin {
  return {
    name: "agentbox-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace(/<!--art:([\w/-]+)(?:\s+([^>]*?))?-->/g, (_m, name: string, attrs?: string) =>
            art(name, attrs ?? ""),
          )
          .replace(/<!--pic:([^>]*?)-->/g, (_m, spec: string) => picture(spec.trim()))
          .replace(/<!--plans-->/g, () => plansHtml())
          .replace(/\{\{app\}\}/g, APP_LOGIN);
      },
    },
  };
}

export default defineConfig({
  plugins: [agentboxHtml()],
  build: { target: "es2022", cssMinify: true, sourcemap: false, assetsInlineLimit: 0 },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
