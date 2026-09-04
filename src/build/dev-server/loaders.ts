// Dev module loaders: the generation-cache-busting base loader, and the request loader
// that layers the next-compat server bundles or the `"use cache"` wrapper on top of it.

import { join, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../../server/types.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { createUseCacheLoader } from "../use-cache-loader.ts";
import type { DevState } from "./state.ts";

/** Dev module loader: cache-bust via the generation query so edits reload. */
export function baseLoaderFor(st: DevState): ModuleLoader {
  return (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(`${href}?g=${st.generation}`);
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
): ModuleLoader {
  const base = baseLoaderFor(st);
  return async (filePath) => {
    if (await isCompat()) {
      await getManifest();
      return st.compatLoad!(filePath);
    }
    if (!st.useCacheEnabled) return base(filePath);
    if (st.ucLoadGen !== st.generation) {
      st.ucLoad = createUseCacheLoader(base, {
        projectDir: st.paths.projectDir,
        cacheDir: join(st.paths.outDir, "server-cache", String(st.generation)),
      });
      st.ucLoadGen = st.generation;
    }
    return st.ucLoad!(filePath);
  };
}
