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

import { fromFileUrl, join } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";

/** Options for {@link createNextCompatServerLoader}. */
export interface NextCompatServerLoaderOptions {
  /**
   * Absolute source module path → its compat server bundle: either a bundle path (one file
   * per module) or a keyed ref `<bundle>#<export>` (one bundle for the whole app; the module
   * is the namespace exported under `<export>`). See {@link keyedBundleRef}.
   */
  moduleMap: Map<string, string>;
}

/** A module's ref inside the single server bundle: `<bundle path>#<namespace export>`. */
export function keyedBundleRef(bundle: string, key: string): string {
  return `${bundle}#${key}`;
}

/** Split a {@link keyedBundleRef} (a plain bundle path has no key). */
export function splitBundleRef(ref: string): { bundle: string; key: string | null } {
  const i = ref.lastIndexOf("#");
  return i < 0 ? { bundle: ref, key: null } : { bundle: ref.slice(0, i), key: ref.slice(i + 1) };
}

/**
 * Load a module through `base` by its bundle ref: the whole bundle for a plain path, the
 * keyed namespace for `<bundle>#<key>` (the bundle module itself is imported once and cached
 * by the module system, so 2,700 refs cost one load).
 */
export async function loadBundleRef(base: ModuleLoader, ref: string): Promise<unknown> {
  const { bundle, key } = splitBundleRef(ref);
  const ns = await base(bundle);
  if (key === null) return ns;
  const sub = (ns as Record<string, unknown>)[key];
  if (sub === undefined) {
    throw new Error(`denext: compat server bundle ${bundle} has no module export "${key}"`);
  }
  return sub;
}

/**
 * Rebuild the absolute source → compat server bundle map from the build manifest's
 * relative form (`compatServerModules`: project-relative source → outDir-relative bundle).
 * Shared by the prod server at startup and the build's own finalize stage.
 */
export function compatModuleMapFromManifest(
  projectDir: string,
  outDir: string,
  rel: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [relSrc, relBundle] of Object.entries(rel)) {
    map.set(join(projectDir, relSrc), join(outDir, relBundle));
  }
  return map;
}

/**
 * Wrap a base {@link ModuleLoader} so route source modules that have a react→denext
 * rewritten server bundle load from that bundle instead of source (a keyed ref resolves to
 * the module's namespace inside the single server bundle).
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
    return bundle ? loadBundleRef(base, bundle) : base(filePath);
  };
}

/**
 * A loader for the boundary's refs (`file://` source URLs → the compat module), for
 * {@link ../runtime/client-reference.ts | tagClientModules} / `tagServerModules`: tagging
 * must see the SAME instances the page bundles reference, which the keyed bundle gives by
 * construction. Non-compat refs load from source.
 */
export function boundaryRefLoader(load: ModuleLoader): (url: string) => Promise<unknown> {
  return (url) => load(url.startsWith("file:") ? fromFileUrl(url) : url);
}
