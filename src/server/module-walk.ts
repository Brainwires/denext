// The directory walk `jobs/` and `services/` discovery share: every module under a directory
// (dotfiles and `_private` files skipped), named by its path without the extension, imported in
// the root context. A module that fails to load is logged and skipped — one bad file never takes
// the server down.

import { walk } from "@std/fs";
import { toFileUrl } from "@std/path";
import { inRootContext } from "./root-context.ts";

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
      skip: [/[/\\]\.[^/\\]+/, /[/\\]_/], // dotfiles/dirs and `_private` files
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
