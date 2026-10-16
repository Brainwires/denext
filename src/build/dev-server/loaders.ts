// Dev module loaders: the generation-cache-busting base loader, and the request loader
// that layers the next-compat server bundles or the `"use cache"` wrapper on top of it.

import { join, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../../server/types.ts";
import { inRootContext } from "../../server/root-context.ts";
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
    // Outside the request that first asks for it: a module is shared by every request (see
    // src/server/root-context.ts).
    return inRootContext(() => import(bust ? `${href}?g=${st.generation}` : href));
  };
}

/**
 * The loader every server-side import goes through. In compat mode it defers to the
 * react→denext server bundles of the rendered request's target (`compatLoader`: web's are built
 * by `getManifest → refreshBoundary` once per generation, before the boundary refs are
 * redirected; a shell's own on its first request). Otherwise it is the base loader,
 * wrapped by the copy compiler once a module is edited, a platform file redirects an import or
 * Cache Components are on. The `?g=` query busts only the module asked for: Deno resolves its
 * relative imports without it, so an edited module it imports would stay cached for the life of
 * the process. The compiler (rebuilt per generation, over the session's {@link DevState.devCopies})
 * loads each edited module, and every module on the way to it, as a copy named by its content.
 */
export function createDevLoader(
  st: DevState,
  compatLoader: (platform: Platform) => Promise<ModuleLoader>,
  isCompat: () => Promise<boolean>,
  opts: { bust?: boolean; platform?: Platform } = {},
): ModuleLoader {
  const bust = opts.bust ?? true;
  const base = baseLoaderFor(st, bust);
  return async (filePath) => {
    // The rendered request's target (or the one asked for): its platform files ride the same
    // per-generation copy loader (or, for a next-compat app, its own compat build), one per
    // target (each writes its own copies).
    const platform = opts.platform ?? renderPlatform();
    if (await isCompat()) return (await compatLoader(platform))(filePath);
    const redirects = await devPlatformRedirects(st, platform);
    // A shell's render (`platform` other than `web`) folds `denext/platform` in its copies.
    if (
      !st.useCacheEnabled && Object.keys(redirects).length === 0 && !st.devCopies.anyEdited &&
      platform === "web"
    ) return base(filePath);
    let current = st.ucLoads.get(platform);
    if (current?.gen !== st.generation) {
      // One directory per target for the session: a copy's name carries its content.
      const dir = platform === "web" ? "dev" : `dev-${platform}`;
      // The render and the boundary tagging share one compiler, so a module the render loads
      // as a copy is tagged (an action registered) as that same copy.
      const [load, tag] = createUseCacheLoaders([baseLoaderFor(st), baseLoaderFor(st, false)], {
        projectDir: st.paths.projectDir,
        cacheDir: join(st.paths.outDir, "server-cache", dir),
        redirects,
        useCache: st.useCacheEnabled,
        dev: st.devCopies,
        platform,
      });
      current = { gen: st.generation, load, tag };
      st.ucLoads.set(platform, current);
    }
    return (bust ? current.load : current.tag)(filePath);
  };
}
