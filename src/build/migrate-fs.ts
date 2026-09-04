// Small filesystem probes shared by the migration paths (Next / SPA / Remix).

import { join } from "@std/path";

/** Whether `p` exists (file or directory). */
export async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether any of `names` exists in `dir`. */
export async function anyExists(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    if (await exists(join(dir, n))) return true;
  }
  return false;
}

/** The first of `names` that exists in `dir` (relative filename), or null. */
export async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    if (await exists(join(dir, n))) return n;
  }
  return null;
}
