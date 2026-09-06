// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.
//
// The stages live under `./build-pipeline/` around one shared `BuildContext`: `prepare`
// (SPA / plugin-only builds, staging setup), `transforms` (app CSS + client rewrites),
// `routes` (route CSS, static/interactive partition, native route + Flight bundles),
// `compat` (the next-compat pipeline) and `finalize` (public env, fonts, manifest, atomic
// swap, typed modules, size summary). This module runs them in order.

import { buildCompat } from "./build-pipeline/compat.ts";
import { type BuildResult, log, timed } from "./build-pipeline/context.ts";
import { finalizeBuild } from "./build-pipeline/finalize.ts";
import { buildWithoutAppRouter, pluginBuildSteps, prepareBuild } from "./build-pipeline/prepare.ts";
import {
  bundleNativeFlight,
  bundleNativeRoutes,
  computeBoundary,
  emitRouteCss,
  partitionRoutes,
} from "./build-pipeline/routes.ts";
import { buildCss, clientTransforms } from "./build-pipeline/transforms.ts";
import { resolveProject } from "./paths.ts";

export type { BuildResult } from "./build-pipeline/context.ts";

/** Build the project at `projectDir` into its `.denext/` output dir. */
export async function build(projectDir: string): Promise<BuildResult> {
  const paths = await timed("resolveProject", () => resolveProject(projectDir));
  const early = await buildWithoutAppRouter(paths);
  if (early) return early;

  const ctx = await timed("prepareBuild", () => prepareBuild(projectDir, paths));
  const css = await timed("buildCss", () => buildCss(ctx));
  // The CSS shims plus the client-transform redirects form the bundler import map.
  ctx.cssImportMap = {
    ...css?.importMap,
    ...await timed("clientTransforms", () => clientTransforms(ctx)),
  };
  const built = { ...ctx, css };

  await timed("emitRouteCss", () => emitRouteCss(built));
  await timed("partitionRoutes", () => partitionRoutes(built));
  await timed("bundleNativeRoutes", () => bundleNativeRoutes(built));
  await timed("computeBoundary", () => computeBoundary(built));
  await timed("bundleNativeFlight", () => bundleNativeFlight(built));
  await timed("buildCompat", () => buildCompat(built));
  await timed("finalizeBuild", () => finalizeBuild(built, () => pluginBuildSteps(paths)));

  log(`\nBuilt ${built.routes.length} route bundle(s) into ${paths.outDir}`);
  return { routes: built.routes, outDir: paths.outDir };
}
