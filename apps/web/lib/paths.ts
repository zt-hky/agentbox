const MAX_PATH = 2048;

/**
 * Path on a workspace host to continue to after handoff. Always returns a string that starts
 * with exactly one `/`; anything suspicious collapses to `/`.
 */
export function sanitizeReturnPath(input: string | null | undefined): string {
  if (!input) return "/";
  if (input.length > MAX_PATH) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) return "/";
  if (!/^[/\\]/.test(input)) return "/";
  const collapsed = "/" + input.replace(/^[/\\]+/, "");
  if (collapsed.includes("\\")) return "/";
  return collapsed;
}

/** Same-app `next=` redirect target. Rejects anything that could leave the origin. */
export function sanitizeNextPath(input: string | null | undefined): string {
  if (!input) return "/";
  if (input.length > MAX_PATH) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(input)) return "/";
  if (!input.startsWith("/") || input.startsWith("//")) return "/";
  return input;
}
