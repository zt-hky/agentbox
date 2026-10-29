import { RESERVED_LABELS, isValidWorkspaceSlug } from "@agentbox/core/hosts";

/** Prefill for the approve dialog: sanitized email local part. */
export function slugFromEmail(email: string): string {
  let s = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(s)) s = `u${s}`;
  s = s.slice(0, 20);
  while (s.length < 3) s += "0";
  return s;
}

export type SlugCheck = { ok: true } | { ok: false; error: string };

export async function checkSlug(
  slug: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<SlugCheck> {
  if ((RESERVED_LABELS as readonly string[]).includes(slug)) {
    return { ok: false, error: `"${slug}" is a reserved name` };
  }
  if (!isValidWorkspaceSlug(slug)) {
    return {
      ok: false,
      error:
        "Slug must be 3-20 characters: a lowercase letter followed by lowercase letters or digits",
    };
  }
  if (await isTaken(slug)) return { ok: false, error: `"${slug}" is already taken` };
  return { ok: true };
}
