import { unstable_rethrow } from "next/navigation";
import { UserError } from "./errors";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** Wraps an action body: UserError -> `{ok:false}`, framework control flow rethrown. */
export async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof UserError) return { ok: false, error: e.message };
    console.error("server action failed", e);
    return { ok: false, error: "Something went wrong" };
  }
}
