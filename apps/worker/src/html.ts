const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#0a0a0a;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:26rem;margin:1rem;padding:1.5rem;background:#fff;border:1px solid #e5e5e5;border-radius:.75rem;box-shadow:0 1px 2px rgba(0,0,0,.05)}
h1{margin:0 0 .5rem;font-size:1.125rem;font-weight:600}
p{margin:0 0 1rem;color:#737373}
p:last-child{margin-bottom:0}
a.btn{display:inline-block;padding:.5rem 1rem;border-radius:.5rem;background:#171717;color:#fafafa;text-decoration:none;font-weight:500}
.spin{width:1.5rem;height:1.5rem;margin-bottom:1rem;border:2px solid #e5e5e5;border-top-color:#171717;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}.card{background:#171717;border-color:#262626}p{color:#a3a3a3}a.btn{background:#fafafa;color:#171717}.spin{border-color:#262626;border-top-color:#fafafa}}
`;

function layout(title: string, body: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${esc(title)}</title><style>${CSS}</style></head><body><main class="card">${body}</main></body></html>`;
}

export function wakingPage(opts: { ws: string; heading: string; detail: string }): string {
  return layout(
    opts.heading,
    `<div class="spin" role="status" aria-label="Loading"></div><h1>${esc(opts.heading)}</h1><p>${esc(opts.detail)}</p><p>Workspace: ${esc(opts.ws)}. This page refreshes automatically.</p>`,
    3,
  );
}

export function failedPage(opts: { ws: string; retryHref: string }): string {
  return layout(
    "Workspace failed to start",
    `<h1>Workspace failed to start</h1><p>Workspace ${esc(opts.ws)} could not be started after several attempts.</p><p><a class="btn" href="${esc(opts.retryHref)}">Try again</a></p>`,
  );
}

export function creditsPage(opts: { ws: string; billingUrl: string }): string {
  return layout(
    "Workspace paused: out of credits",
    `<h1>Workspace paused: out of credits</h1><p>Workspace ${esc(opts.ws)} is asleep and has no credits or free allowance left to start.</p><p><a class="btn" href="${esc(opts.billingUrl)}">Open billing</a></p>`,
  );
}

export function capacityPage(opts: { ws: string }): string {
  return layout(
    "Server at capacity, retrying",
    `<div class="spin" role="status" aria-label="Loading"></div><h1>Server at capacity, retrying</h1><p>There is no room to start workspace ${esc(opts.ws)} right now. This page refreshes automatically.</p>`,
    30,
  );
}

export function messagePage(opts: {
  title: string;
  message: string;
  href?: string;
  linkText?: string;
}): string {
  const link = opts.href
    ? `<p><a class="btn" href="${esc(opts.href)}">${esc(opts.linkText ?? "Continue")}</a></p>`
    : "";
  return layout(opts.title, `<h1>${esc(opts.title)}</h1><p>${esc(opts.message)}</p>${link}`);
}
