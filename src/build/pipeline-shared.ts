// Helpers shared by the production build (`./build-pipeline/`) and the static export
// (`./export-pipeline/`) — the two pipelines run the same preparation, next-compat module
// discovery and font collection over a project.

import { fromFileUrl, join } from "@std/path";
import { resolveCacheComponents } from "../server/config.ts";
import { collectedFontEntries, resetFonts } from "../compat/next/font/registry.ts";
import { applyPlugins } from "../plugin/mod.ts";
import type { ApiRoute, PageRoute } from "../router/manifest.ts";
import { nodeResolveEnabled } from "../server/config.ts";
import { defaultLoader } from "../server/mod.ts";
import type { ModuleLoader } from "../server/types.ts";
import { routeServerModules } from "./bundle.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import type { ProjectPaths } from "./paths.ts";
import { compileCssAsset } from "./css-url.ts";
import { CLIENT_PREFIX } from "./prod-server/assets.ts";
import type { AssetOptions } from "./next-compat.ts";

/** Whether `path` is an existing directory. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Run plugin setup (route-synthesizer plugins must register before the route scan). */
export function setupPlugins(paths: ProjectPaths, mode: "build" | "export"): Promise<void> {
  return applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode,
    load: defaultLoader,
  });
}

/**
 * The app-wide boundary manifest (client islands + server-action modules). Crawls from
 * every route's full server tree (page + layouts + templates + slots), not just page
 * files, so a client island imported only by a layout is found (H1).
 */
export function appBoundaryManifest(appDir: string, pages: PageRoute[]): Promise<BoundaryManifest> {
  return buildBoundaryManifest(
    appDir,
    [...new Set(pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
}

/**
 * next-compat: the route server modules (page/layout/…) AND every boundary island +
 * server-action module, deduped — bundled as separate entries in ONE code-split pass so a
 * page's reference to an island resolves to the SAME module instance the SSR loader tags.
 */
export function compatModuleList(
  pages: PageRoute[],
  boundary: BoundaryManifest | null,
  api: ApiRoute[] = [],
): string[] {
  const refs = boundary ? [...boundary.client.values(), ...boundary.server.values()] : [];
  // Route handlers (`route.ts`) go through the same bundle: a migrated Remix action route
  // imports the same `.server.ts` graph (assets, npm deps) as its page.
  return [
    ...new Set([
      ...pages.flatMap(routeServerModules),
      ...api.map((r) => r.filePath),
      ...refs.map((r) => fromFileUrl(r.url)),
    ]),
  ];
}

/** The options every next-compat bundling call shares. */
export function compatBuildOptions(
  projectDir: string,
  paths: ProjectPaths,
  cssImportMap?: Record<string, string>,
  clientDir: string = join(paths.outDir, "client"),
) {
  return {
    projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true as const,
    classComponents: paths.config?.classComponents ?? true,
    resolveAllNodeModules: nodeResolveEnabled(paths.config),
    mdxOptions: paths.config?.mdx,
    useCache: resolveCacheComponents(paths.config),
    cssImportMap,
    // Assets emit into the dir the CLIENT bundles are written to — the build pipeline's
    // staging dir, swapped into `client/` at finalize (emitting into `client/` directly
    // would be wiped by that swap).
    assets: compatAssets(projectDir, clientDir),
  };
}

/**
 * Vite-style asset emission for a compat build: imported images/fonts and `?url`
 * stylesheets land in the client dir under content-hashed names, served immutable under
 * `/_denext/client/assets/`. Shared by the server and client bundles so their URLs agree.
 */
export function compatAssets(projectDir: string, clientDir: string): AssetOptions {
  return {
    publicPath: CLIENT_PREFIX,
    emitDir: clientDir,
    compileCss: (path) => compileCssAsset(projectDir, path),
  };
}

/**
 * Execute each page + layout module so its top-level `next/font/google` declarations
 * register, and return the collected Google stylesheet entries. A module that can't load
 * at build (needs a request context, etc.) is skipped — its fonts fall back to a runtime
 * <link>. Resets the font registry first.
 */
export async function collectPageFontEntries(
  pages: PageRoute[],
  load: ModuleLoader,
): Promise<Array<{ url: string; subsets: string[] | undefined }>> {
  resetFonts();
  const fontModules = new Set<string>();
  for (const p of pages) {
    fontModules.add(p.filePath);
    for (const layout of p.layoutChain) fontModules.add(layout);
  }
  for (const fp of fontModules) {
    try {
      await load(fp);
    } catch { /* module needs a request context / failed to load → skip its fonts */ }
  }
  return collectedFontEntries().map(([url, meta]) => ({ url, subsets: meta.subsets }));
}
