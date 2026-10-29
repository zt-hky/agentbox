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
  pids: number;
  allowanceRuntimeHours: number;
  allowanceCpuCoreHours: number;
  allowanceMemGbHours: number;
}
interface PlansFile {
  creditLabel: string;
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
  const credits = (micro: number) => {
    const v = micro / 1_000_000;
    return `${num(v)} ${label}${v === 1 ? "" : "s"}`;
  };
  const cols = data.plans
    .map((p) => {
      const priced = p.monthlyPriceMicro > 0;
      const price = priced
        ? credits(p.monthlyPriceMicro)
        : p.kind === "payg"
          ? "No monthly fee"
          : `0 ${label}s`;
      const per = priced
        ? "per month"
        : p.kind === "payg"
          ? "Pay only for what runs"
          : "Included with access";
      const allowance =
        p.allowanceRuntimeHours > 0
          ? `<li><b>${num(p.allowanceRuntimeHours)} h</b><span>runtime a month</span></li><li><b>${num(p.allowanceCpuCoreHours)}</b><span>CPU core-hours</span></li><li><b>${num(p.allowanceMemGbHours)}</b><span>GB-hours of memory</span></li>`
          : `<li class="none"><b>Metered</b><span>from your credit balance, measured every minute</span></li>`;
      const mem = p.memoryMb >= 1024 ? `${num(p.memoryMb / 1024)} GB` : `${p.memoryMb} MB`;
      return `<article class="plan${p.kind === "package" ? " is-feature" : ""}">
  <h3>${esc(p.name)}</h3>
  <p class="plan-price"><span>${esc(price)}</span><small>${esc(per)}</small></p>
  <ul class="plan-limits">
    <li><b>${num(p.cpu)}</b><span>CPU cores</span></li>
    <li><b>${mem}</b><span>memory</span></li>
    <li><b>${num(p.diskGb)} GB</b><span>disk</span></li>
    <li><b>${p.pids}</b><span>processes</span></li>
  </ul>
  <p class="plan-sub">Monthly allowance</p>
  <ul class="plan-allow">${allowance}</ul>
  <a class="btn btn-${p.kind === "package" ? "primary" : "ghost"}" href="${APP_LOGIN}">Request access</a>
</article>`;
    })
    .join("\n");
  const r = data.prices;
  const rate = (m: number) => num(m / 1_000_000);
  const rates = `<p class="rates"><span class="mono">[ METERED ]</span><span>${rate(r.runtimePerHour)} ${label}s per runtime hour</span><i></i><span>${rate(r.cpuCorePerHour)} per CPU core-hour</span><i></i><span>${rate(r.memGbPerHour)} per GB-hour of memory</span></p>`;
  return `<div class="plans">${cols}</div>${rates}`;
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
