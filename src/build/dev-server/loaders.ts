// Dev module loaders: the generation-cache-busting base loader, and the request loader
// that layers the next-compat server bundles or the `"use cache"` wrapper on top of it.

import { join, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../../server/types.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { createUseCacheLoaders } from "../use-cache-loader.ts";
import type { DevState } from "./state.ts";
import { devPlatformRedirects, renderPlatform } from "./platform.ts";
import type { Platform } from "../platform-extensions.ts";

/**
 * Dev module loader: cache-bust via the generation query so edits reload.
 *
 * `bust: false` drops the `?g=` query — used for TAGGING `"use client"` boundaries.
 * A page loaded as `page.tsx?g=N` resolves its static `import "./island.tsx"`
 * query-less (Deno drops the referrer's query on relative resolution), so the RENDERED
 * island is the query-less module instance. Tagging must hit that same instance — a
 * queried `island.tsx?g=N` is a different object and its `CLIENT_REF` tag never reaches
 * the rendered one, so the island serializes as plain host nodes (no island to hydrate).
 */
export function baseLoaderFor(st: DevState, bust = true): ModuleLoader {
  return (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(bust ? `${href}?g=${st.generation}` : href);
  };
}

/**
 * The loader every server-side import goes through. In compat mode it defers to the
 * react→denext server bundles that `getManifest → refreshBoundary` builds (once per
 * generation, before the boundary refs are redirected). Otherwise it is the base loader,
 * wrapped for Cache Components when enabled — the wrapper (and the transformed copies it
 * writes) is rebuilt per generation so edits are picked up on reload.
 */
export function createDevLoader(
  st: DevState,
  getManifest: () => Promise<RouteManifest>,
  isCompat: () => Promise<boolean>,
  opts: { bust?: boolean; platform?: Platform } = {},
): ModuleLoader {
  const bust = opts.bust ?? true;
  const base = baseLoaderFor(st, bust);
  return async (filePath) => {
    if (await isCompat()) {
      await getManifest();
      return st.compatLoad!(filePath);
    }
    // The rendered request's target (or the one asked for): its platform files ride the same
    // per-generation copy loader, one per target (each writes its own copies).
    const platform = opts.platform ?? renderPlatform();
    const redirects = await devPlatformRedirects(st, platform);
    if (!st.useCacheEnabled && Object.keys(redirects).length === 0) return base(filePath);
    let current = st.ucLoads.get(platform);
    if (current?.gen !== st.generation) {
      const dir = platform === "web" ? String(st.generation) : `${st.generation}-${platform}`;
      // The render and the boundary tagging share one compiler, so a module the render loads
      // as a copy is tagged (an action registered) as that same copy.
      const [load, tag] = createUseCacheLoaders([baseLoaderFor(st), baseLoaderFor(st, false)], {
        projectDir: st.paths.projectDir,
        cacheDir: join(st.paths.outDir, "server-cache", dir),
        redirects,
        useCache: st.useCacheEnabled,
      });
      current = { gen: st.generation, load, tag };
      st.ucLoads.set(platform, current);
    }
    return (bust ? current.load : current.tag)(filePath);
  };
}
