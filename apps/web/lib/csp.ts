export interface CspOptions {
  /** `next dev` needs eval for React refresh; never set in production. */
  dev?: boolean;
}

export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildCsp(nonce: string, opts: CspOptions = {}): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (opts.dev) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' https://accounts.google.com https://github.com",
  ].join("; ");
}

export function securityHeaders(nonce: string, opts: CspOptions = {}): Record<string, string> {
  return {
    "Content-Security-Policy": buildCsp(nonce, opts),
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}
