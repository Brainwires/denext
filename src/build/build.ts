// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.
//
// The stages live under `./build-pipeline/` around one shared `BuildContext`: `prepare`
// (SPA / plugin-only builds, staging setup), `transforms` (app CSS + client rewrites),
// `routes` (route CSS, static/interactive partition, native route + Flight bundles),
// `compat` (the next-compat pipeline) and `finalize` (public env, fonts, manifest, atomic
// swap, typed modules, size summary). This module runs them in order.

import { buildCompat } from "./build-pipeline/compat.ts";
import { type BuildContext, type BuildResult, log, timed } from "./build-pipeline/context.ts";
import { setModuleGraphRedirects } from "./module-graph.ts";
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

  try {
    return await buildAppRouter(await timed("prepareBuild", () => prepareBuild(projectDir, paths)));
  } finally {
    // The web target's graph redirects belong to this build only.
    setModuleGraphRedirects(null);
  }
}

/** Run every App Router build stage over a prepared context. */
async function buildAppRouter(ctx: BuildContext): Promise<BuildResult> {
  const { paths } = ctx;
  const css = await timed("buildCss", () => buildCss(ctx));
  // The CSS shims form the bundler import map; the client transforms resolve with the
  // platform-file redirects and the action stubs (./client-imports.ts).
  ctx.transforms = await timed("clientTransforms", () => clientTransforms(ctx));
  ctx.cssImportMap = { ...css?.importMap };
  const built = { ...ctx, css };

  await timed("emitRouteCss", () => emitRouteCss(built));
  await timed("partitionRoutes", () => partitionRoutes(built));
  // The boundary first: every client bundle (whole-route ones too) stubs its actions.
  await timed("computeBoundary", () => computeBoundary(built));
  await timed("bundleNativeRoutes", () => bundleNativeRoutes(built));
  await timed("bundleNativeFlight", () => bundleNativeFlight(built));
  await timed("buildCompat", () => buildCompat(built));
  await timed("finalizeBuild", () => finalizeBuild(built, () => pluginBuildSteps(paths)));

  log(`\nBuilt ${built.routes.length} route bundle(s) into ${paths.outDir}`);
  return { routes: built.routes, outDir: paths.outDir };
}
