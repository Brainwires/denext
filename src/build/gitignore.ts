// Shared `.gitignore` appender for the migrate / prisma-migrate build steps.

import { join } from "@std/path";

/**
 * Append `entries` to `dir`'s `.gitignore` under the denext marker, idempotently:
 * entries already present (anywhere) are skipped, and the marker line is written
 * only once. Returns the `.gitignore` path when it was created or changed, or
 * `null` when every entry was already present (nothing written).
 *
 * Symlink-safe: `Deno.writeTextFile` follows a symlink and writes its target, so
 * a `.gitignore` committed as a symlink (migrate runs on cloned third-party
 * repos) could otherwise redirect this append out of tree. Removing the path
 * first unlinks the symlink itself — the same guard `writeMergedModuleConfig`
 * uses.
 */
export async function appendGitignore(dir: string, entries: string[]): Promise<string | null> {
  const path = join(dir, ".gitignore");
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch { /* no .gitignore yet — create one */ }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length === 0) return null;
  const marker = "# denext generated build artifacts";
  const block = (have.has(marker) ? "" : `${marker}\n`) + missing.join("\n") + "\n";
  // Separate from existing content with a blank line; finish a dangling last line first.
  const lead = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, current + lead + block);
  return path;
}
