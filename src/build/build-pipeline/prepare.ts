// Production build, stage 0: the non-App-Router builds and the staging setup.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { runPluginBuildSteps } from "../../plugin/mod.ts";
import { scanRoutes } from "../../router/manifest.ts";
import { computeBoundaryRoutes } from "../module-graph.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import type { ProjectPaths } from "../paths.ts";
import { dirExists, setupPlugins } from "../pipeline-shared.ts";
import { buildSpa } from "../spa.ts";
import { type BuildContext, type BuildResult, log } from "./context.ts";

/** Plugin build steps (e.g. a Pages Router bundling its own client entries). */
export function pluginBuildSteps(paths: ProjectPaths): Promise<void> {
  return runPluginBuildSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  });
}

/**
 * The builds that bypass the App Router pipeline, or null when the app has an `app/`
 * tree: SPA mode ("React but not Next") bundles the single client entry and emits an HTML
 * shell; an app with no `app/` dir (Pages Router) has nothing to scan/bundle — the
 * `@denext/pages-router` plugin owns that build, so only plugin setup + build steps run.
 */
export async function buildWithoutAppRouter(paths: ProjectPaths): Promise<BuildResult | null> {
  if (paths.config?.mode === "spa") {
    const { outDir } = await buildSpa(paths);
    return { routes: [], outDir };
  }
  if (await dirExists(paths.appDir)) return null;
  await ensureDir(paths.outDir);
  await setupPlugins(paths, "build");
  await pluginBuildSteps(paths);
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
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const boundaryRoutes = manifest.pages.filter((p) => flightRoutes.has(p.routePath));
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
    routes: [],
    staticRoutes: [],
    clientRoutes: [],
    boundary: null,
    usesLive: false,
    compatServerModules: {},
  };
}
