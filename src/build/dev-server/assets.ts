// Per-generation client assets: the app CSS (import-map shims + per-route stylesheets)
// and the build-transform redirect maps (auto-memo compiler, qrl handler extraction, Fast
// Refresh registrations),
// merged into the client bundle's import map.

import { composeRedirects } from "../platform-extensions.ts";
import { devPlatformRedirects } from "./platform.ts";
import { reactCompilerEnabled } from "../../server/config.ts";
import { type AppCss, buildAppCss } from "../css.ts";
import { tailwindPaths } from "../tailwind.ts";
import { collectComponentSources, compileModules } from "../compiler.ts";
import { compileQrlModules } from "../qrl-transform.ts";
import { compileRefreshModules } from "../refresh-modules.ts";
import { routeEntryFiles } from "../module-graph.ts";
import type { DevState } from "./state.ts";

/**
 * CSS assets, rebuilt per generation. `import()` of `.css` on the server is handled by
 * the CLI's `--config` re-exec; here we supply the client-bundle import map and the
 * per-route extracted stylesheet. Route entry sources feed the cross-package style crawl
 * (sibling workspace packages outside `projectDir`): `getCss` can run before the manifest
 * is scanned (walk-only, entryFiles empty); once the manifest exists, rebuild once this
 * generation so those out-of-tree stylesheets are picked up.
 */
export async function getCss(st: DevState): Promise<AppCss | null> {
  const entryFiles = st.manifest ? [...new Set(st.manifest.pages.flatMap(routeEntryFiles))] : [];
  const wantEntries = entryFiles.length > 0;
  if (st.cssGen !== st.generation || (wantEntries && !st.cssHadEntries)) {
    st.cssAssets = await buildAppCss({
      projectDir: st.paths.projectDir,
      configPath: st.paths.configPath,
      outDir: st.paths.outDir,
      minify: false,
      entryFiles,
      tailwind: tailwindPaths(st.paths.projectDir, st.paths.config?.tailwind),
    });
    st.cssGen = st.generation;
    st.cssHadEntries = wantEntries;
  }
  return st.cssAssets;
}

/**
 * Auto-memo compiler (opt-in) + qrl handler extraction (rides on the
 * `resumable` route export, self-filtering): original → transformed module URLs, rebuilt
 * per generation so edits are picked up on reload. qrl takes precedence on a module both
 * touch (handler extraction on resumable).
 */
export async function getTransformMaps(st: DevState): Promise<Record<string, string>> {
  if (st.compilerGen !== st.generation) {
    const sources = await collectComponentSources(st.paths.projectDir);
    st.compilerMap = reactCompilerEnabled(st.paths.config)
      ? await compileModules(sources, { outDir: st.paths.outDir })
      : {};
    st.qrlMap = await compileQrlModules(sources, { outDir: st.paths.outDir });
    st.compilerGen = st.generation;
  }
  return { ...st.compilerMap, ...st.qrlMap };
}

/**
 * Fast Refresh families for every component of the bundled client, over the compiler + qrl
 * output (the bundled entries register only the route-structural components and the
 * client-reference exports). Rebuilt per generation; the unbundled loop registers per module.
 */
async function getRefreshMap(st: DevState): Promise<Record<string, string>> {
  if (st.refreshGen !== st.generation) {
    const prior = await getTransformMaps(st);
    const sources = await collectComponentSources(st.paths.projectDir);
    st.refreshMap = await compileRefreshModules(sources, prior, { outDir: st.paths.outDir });
    st.refreshGen = st.generation;
  }
  return st.refreshMap;
}

/** The merged client-bundle import map (CSS + compiler + qrl + Fast Refresh redirects). */
export async function bundleImportMap(st: DevState): Promise<Record<string, string> | undefined> {
  const css = await getCss(st);
  const refresh = await getRefreshMap(st);
  const merged = {
    ...css?.importMap,
    ...refresh,
    // The web target's platform files, pointed at a variant's refresh copy when it has one.
    ...composeRedirects(await devPlatformRedirects(st), refresh),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
