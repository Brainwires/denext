// Production build, stage 0: the non-App-Router builds and the staging setup.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { EMITTED_DIR, runPluginBuildSteps, runPluginPrepareSteps } from "../../plugin/mod.ts";
import { scanRoutes } from "../../router/manifest.ts";
import {
  assertPlatformFilesResolve,
  computeBoundaryRoutes,
  localModulesOutside,
  routeEntryFiles,
  setModuleGraphRedirects,
} from "../module-graph.ts";
import { platformResolution, projectPlatformRedirects } from "../platform-extensions.ts";
import { platformImportMap } from "../platform-imports.ts";
import {
  appRendersDocumentTags,
  appUsesActivity,
  appUsesClassComponents,
  appUsesIsoIslands,
  appUsesViewTransition,
  type ClassRuntimeMode,
} from "../bundle.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import type { ProjectPaths } from "../paths.ts";
import { setupPlugins } from "../pipeline-shared.ts";
import { dirExists } from "../paths.ts";
import { buildSpa } from "../spa.ts";
import { type BuildContext, type BuildResult, log } from "./context.ts";
import { npmBoundaryByImporter } from "../npm-boundary.ts";
import { buildRouterlessServerCopies } from "../server-copies-build.ts";

/**
 * Plugin build steps (e.g. a Pages Router bundling its own client entries). The files they
 * publish with `emitFile` land in `<outDir>/emitted/` (emptied first, so a file a step no
 * longer emits is not served on), which `denext start` serves ahead of `public/`.
 */
export async function pluginBuildSteps(paths: ProjectPaths): Promise<void> {
  await Deno.remove(join(paths.outDir, EMITTED_DIR), { recursive: true }).catch(() => {});
  await runPluginBuildSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  });
}

/** Plugin prepare steps (codegen the app imports, e.g. a content-collections store + types). */
function pluginPrepareSteps(paths: ProjectPaths): Promise<void> {
  return runPluginPrepareSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  }, { failFast: true });
}

/**
 * The builds that bypass the App Router pipeline, or null when the app has an `app/`
 * tree: SPA mode ("React but not Next") bundles the single client entry and emits an HTML
 * shell; an app with no `app/` dir (Pages Router) has nothing to scan/bundle — the
 * `@denext/pages-router` plugin owns that build, so only plugin setup + build steps run, and the
 * manifest records the server render's copies (platform files, `"use cache"`, inline
 * `"use server"`), which `denext start` and a compiled app load the pages through.
 */
export async function buildWithoutAppRouter(paths: ProjectPaths): Promise<BuildResult | null> {
  if (paths.config?.mode === "spa") {
    const { outDir } = await buildSpa(paths);
    return { routes: [], outDir };
  }
  if (await dirExists(paths.appDir)) return null;
  await ensureDir(paths.outDir);
  await setupPlugins(paths, "build");
  await pluginPrepareSteps(paths);
  await pluginBuildSteps(paths);
  const serverCopies = await buildRouterlessServerCopies(paths);
  await Deno.writeTextFile(
    join(paths.outDir, "manifest.json"),
    `${JSON.stringify({ serverCopies }, null, 2)}\n`,
  );
  return { routes: [], outDir: paths.outDir };
}

/**
 * Prepare an App Router build: drop the durable ISR/data cache (a rebuild invalidates
 * cached renders; server *restarts* keep it — only a rebuild resets it), set up plugins,
 * scan the routes, detect next-compat, and create the empty staging dir the client
 * build is written into (so a mid-build failure never destroys the previous working
 * `client/`, and stale content-hashed chunks from prior builds are dropped).
 */
export async function prepareBuild(projectDir: string, paths: ProjectPaths): Promise<BuildContext> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await Deno.remove(join(paths.outDir, `cache.db${suffix}`)).catch(() => {});
  }
  await setupPlugins(paths, "build");
  await pluginPrepareSteps(paths);
  const manifest = await scanRoutes(paths.appDir);
  const finalClientDir = join(paths.outDir, "client");
  const clientDir = join(paths.outDir, ".client.staging");
  await Deno.remove(clientDir, { recursive: true }).catch(() => {});
  await ensureDir(clientDir);
  // next-compat mode: rewrite react→denext at bundle time so npm React libraries render
  // on denext's single React. The Flight/RSC boundary is preserved in compat too (Stage
  // 4b): a compat route reaching a `"use client"` island renders its server components
  // server-side and hydrates only the islands via the compat flight bundle.
  const compat = await detectNextCompat(paths);
  if (compat) log("next-compat mode: building react→denext SSR + client bundles");
  const platformRedirects = await webPlatformFiles(projectDir, paths, manifest, compat);
  // In compat mode the boundary includes `"use client"` files inside npm packages too.
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages, {
    npm: compat ? npmBoundaryByImporter : undefined,
  });
  const boundaryRoutes = manifest.pages.filter((p) => flightRoutes.has(p.routePath));
  // The build-time feature scans also read the local modules the routes import from OUTSIDE
  // the project (a sibling workspace package), so a class component / `<Activity>` /
  // `<ViewTransition>` defined there counts as used. npm packages are not scanned (their
  // sources are opaque to a token scan) — the class runtime covers them by loading on demand.
  const outside = await localModulesOutside(projectDir, manifest.pages);
  const { classRuntime, usesActivity, usesViewTransition, usesIsoIslands, usesSingletons } =
    await runtimeFeatureScans(projectDir, paths, outside);
  return {
    projectDir,
    paths,
    manifest,
    clientDir,
    finalClientDir,
    compat,
    flightRoutes,
    boundaryRoutes,
    hasFlight: boundaryRoutes.length > 0,
    css: null,
    cssImportMap: {},
    transforms: {},
    platformRedirects,
    routes: [],
    staticRoutes: [],
    clientRoutes: [],
    boundary: null,
    crawledBoundary: null,
    serverModules: new Map(),
    usesLive: false,
    usesLiveView: false,
    classRuntime,
    usesActivity,
    usesViewTransition,
    usesIsoIslands,
    usesSingletons,
    compatServerModules: {},
  };
}

/**
 * The web target's platform files (`.web.tsx`): file-URL redirects on the native path (the
 * compat bundles probe them), which every crawl of the build resolves through too.
 */
async function webPlatformFiles(
  projectDir: string,
  paths: ProjectPaths,
  manifest: BuildContext["manifest"],
  compat: boolean,
): Promise<BuildContext["platformRedirects"]> {
  const platformRedirects = compat
    ? {}
    : await projectPlatformRedirects(projectDir, paths.config, "web");
  const platformImports = compat ? { importMap: {}, originals: {} } : await platformImportMap(
    projectDir,
    platformRedirects,
    join(paths.outDir, "platform-imports", "web"),
  );
  setModuleGraphRedirects(paths.configPath, platformImports);
  if (!compat) {
    await assertPlatformFilesResolve(
      [...new Set(manifest.pages.flatMap(routeEntryFiles))],
      projectDir,
      platformResolution(paths.config, "web"),
    );
  }
  return platformRedirects;
}

/** Which on-demand runtimes the build installs, from scans of the app's own sources. */
async function runtimeFeatureScans(
  projectDir: string,
  paths: ProjectPaths,
  outside: Awaited<ReturnType<typeof localModulesOutside>>,
): Promise<
  Pick<
    BuildContext,
    "classRuntime" | "usesActivity" | "usesViewTransition" | "usesIsoIslands" | "usesSingletons"
  >
> {
  // The class-component runtime is a code-split chunk the generated entry loads on demand
  // when the server-rendered document says a class rendered ("lazy" — the default, and what
  // makes a class hidden in a dependency work in production). The scan is a preload hint:
  // when the app's own sources name a class (or `classComponents: true`), install it eagerly
  // and skip the round trip. `classComponents: false` keeps it out entirely ("off").
  // Computed here (before native + Flight bundling) so both route paths see it.
  const classRuntime: ClassRuntimeMode = paths.config?.classComponents === false
    ? "off"
    : paths.config?.classComponents === true || await appUsesClassComponents(projectDir, outside)
    ? "eager"
    : "lazy";
  // Gate the Activity offscreen scheduler: install it only when the app renders `<Activity>`
  // (a build scan). Computed here (like classRuntime) so native + Flight route paths both
  // see it. An app can't use Activity without naming it, so the scan can't false-drop.
  const usesActivity = await appUsesActivity(projectDir, outside);
  // Gate the ViewTransition marking runtime, same as Activity — install it only when the app
  // renders `<ViewTransition>` (a build scan).
  const usesViewTransition = await appUsesViewTransition(projectDir, outside);
  // Gate the isomorphic island runtime: only an app that writes a `client:*` directive.
  const usesIsoIslands = await appUsesIsoIslands(projectDir, outside);
  // Gate the host-singleton runtime: install it only when the app renders a document tag (a
  // client root layout's `<html>`/`<body>` adopt the page's own elements).
  const usesSingletons = await appRendersDocumentTags(projectDir, outside);
  return { classRuntime, usesActivity, usesViewTransition, usesIsoIslands, usesSingletons };
}
