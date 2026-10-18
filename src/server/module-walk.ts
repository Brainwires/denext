// The directory walk `jobs/` and `services/` discovery share: every module under a directory
// (dotfiles and `_private` files skipped), named by its path without the extension, imported in
// the root context. A module that fails to load is logged and skipped — one bad file never takes
// the server down.

import { walk } from "@std/fs";
import { toFileUrl } from "@std/path";
import { inRootContext } from "./root-context.ts";

/**
 * The `walk` skip pattern for a discovery directory: an entry under `dir` whose path BELOW it
 * has a dot (`.cache/`, `.x.ts`) or underscore (`_private.ts`, `_shared/`) segment. Anchored to
 * `dir`, so the directories above it never count: a project in `~/.apps/` or `D:\a\_temp\` keeps
 * its modules (an unanchored pattern on the whole path skipped every one of them).
 *
 * @param dir The directory the walk starts at, as passed to `walk`.
 * @returns The pattern for `walk`'s `skip`.
 */
export function privateEntriesUnder(dir: string): RegExp {
  // Either separator matches wherever `dir` has one (`walk` joins with the host's).
  const root = dir.replace(/[/\\]+$/, "").split(/[/\\]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[/\\\\]");
  return new RegExp(`^${root}(?:[/\\\\][^/\\\\]+)*?[/\\\\][._]`);
}

/** One imported module of a discovery directory. */
export interface DiscoveredModule {
  /** Its path under the directory, with the extension (`reports/daily.ts`). */
  readonly rel: string;
  /** Its name: the path without the extension, `/`-separated (`reports/daily`). */
  readonly name: string;
  /** Its absolute path. */
  readonly path: string;
  /** Its exports. */
  readonly mod: Record<string, unknown>;
}

/**
 * Import every module under `dir` in path order of the walk. A missing directory yields nothing.
 *
 * @param dir The directory (`<project>/jobs`, `<project>/services`).
 * @param kind What a module is, for the load-failure log (`"job"`, `"service"`).
 * @returns The modules that loaded.
 */
export async function* importModules(dir: string, kind: string): AsyncGenerator<DiscoveredModule> {
  try {
    if (!(await Deno.stat(dir)).isDirectory) return;
  } catch {
    return; // no such directory
  }
  for await (
    const entry of walk(dir, {
      exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      includeDirs: false,
      skip: [privateEntriesUnder(dir)], // dotfiles/dirs and `_private` files
    })
  ) {
    const rel = entry.path.slice(dir.length).replace(/^[/\\]/, "");
    const name = rel.replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/[/\\]/g, "/");
    let mod: Record<string, unknown>;
    try {
      // A discovered module belongs to no request, even when a request triggers its first use.
      mod = await inRootContext(() => import(toFileUrl(entry.path).href));
    } catch (err) {
      console.error(`denext: failed to load ${kind} "${name}":`, err);
      continue;
    }
    yield { rel, name, path: entry.path, mod };
  }
}
