// Server-side ModuleLoader for the next-compat pipeline.
//
// denext renders by loading route modules through a `ModuleLoader` (native
// dynamic `import` of the source `.tsx`). When a route's subtree imports an npm
// React library, that source pulls a SECOND React from node_modules → dual React
// / `useContext(null)` at SSR. This wrapper redirects a route's source module to
// its pre-built, react→denext-rewritten server bundle (see `buildNextCompatModules`),
// so the whole subtree runs on denext's single React. Non-route modules (and any
// module without a bundle) pass through to the base loader unchanged — the native
// fast path is untouched.
//
// It composes like `createUseCacheLoader`: it delegates to `base` (rather than a
// raw `import`) so dev cache-busting and the use-cache loader still apply, and it
// falls back to the original path on any failure so it can never break loading.

import { fromFileUrl, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";
import type { BoundaryManifest } from "./module-graph.ts";

/** Options for {@link createNextCompatServerLoader}. */
export interface NextCompatServerLoaderOptions {
  /** Map of absolute source module path → absolute prebuilt server bundle path. */
  moduleMap: Map<string, string>;
}

/**
 * Wrap a base {@link ModuleLoader} so route source modules that have a react→denext
 * rewritten server bundle load from that bundle instead of source.
 *
 * @param base The underlying loader (dev cache-bust / use-cache / defaultLoader).
 * @param opts The source→bundle map produced by the build.
 * @returns A loader that redirects mapped modules and passes through the rest.
 */
export function createNextCompatServerLoader(
  base: ModuleLoader,
  opts: NextCompatServerLoaderOptions,
): ModuleLoader {
  return (filePath: string): Promise<unknown> => {
    let abs = filePath;
    try {
      abs = filePath.startsWith("file:") ? fromFileUrl(filePath) : filePath;
    } catch {
      // Unparseable specifier — leave as-is; the lookup just misses.
    }
    const bundle = opts.moduleMap.get(abs);
    return base(bundle ?? filePath);
  };
}

/**
 * Rewrite each boundary ref's module URL to its react→denext compat server bundle
 * (from a source→bundle map), so the Flight SSR renderer tags — and renders for
 * first paint — the SAME island/action instances the page's compat server bundle
 * references (they resolve to one shared runtime chunk). Identity holds because
 * each island/action is bundled as its own build entry (a chunk), never inlined.
 * A ref with no compat bundle is left on its source URL (native fallback).
 *
 * @param boundary The app's boundary manifest (its refs are mutated in place).
 * @param moduleMap Absolute source path → absolute compat server bundle path.
 */
export function redirectBoundaryToCompat(
  boundary: BoundaryManifest,
  moduleMap: Map<string, string>,
): void {
  for (const ref of [...boundary.client.values(), ...boundary.server.values()]) {
    try {
      const bundle = moduleMap.get(fromFileUrl(ref.url));
      if (bundle) ref.url = toFileUrl(bundle).href;
    } catch { /* non-file URL — leave as-is */ }
  }
}
