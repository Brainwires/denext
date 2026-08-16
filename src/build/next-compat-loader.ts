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

import { fromFileUrl } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";

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
