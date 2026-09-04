// Static site export (SSG): pre-render every page — including dynamic routes
// enumerated by `generateStaticParams` — to static HTML plus client bundles, in
// a directory any static host can serve.
//
// The stages live under `./export-pipeline/` around one shared `ExportContext`: `prepare`
// (SPA / Pages Router exports, plugin setup, scan, dirs, loader), `assets` (route
// classification, stylesheets, next-compat SSR bundles, route + Flight bundles, fonts) and
// `render` (every page × param set × locale, then `public/`). This module runs them in order.

import { setImageRuntimeConfig } from "../runtime/image.ts";
import {
  bundleExportFlight,
  bundleExportRoutes,
  classifyRoutes,
  emitExportCss,
  selfHostExportFonts,
  setupCompat,
} from "./export-pipeline/assets.ts";
import type { StaticExportOptions, StaticExportResult } from "./export-pipeline/context.ts";
import { exportWithoutAppRouter, prepareExport } from "./export-pipeline/prepare.ts";
import { copyPublic, renderAllPages } from "./export-pipeline/render.ts";
import { stopNextCompat } from "./next-compat.ts";
import { resolveProject } from "./paths.ts";

export type { StaticExportOptions, StaticExportResult } from "./export-pipeline/context.ts";

/** Pre-render a denext app to a static, host-anywhere directory. */
export async function staticExport(
  projectDir: string,
  options: StaticExportOptions = {},
): Promise<StaticExportResult> {
  const paths = await resolveProject(projectDir);
  // Static export ships no `/_denext/image` server, so `<Image>` must render plain `<img>`
  // with the raw `src` (Next forces `unoptimized` for `output: export` the same way). A
  // per-image custom `loader` still optimizes via its CDN. `deviceSizes`/`imageSizes` are
  // irrelevant with no built-in optimizer.
  setImageRuntimeConfig({ unoptimized: true });
  const early = await exportWithoutAppRouter(paths, options);
  if (early) return early;

  const ctx = await prepareExport(projectDir, paths, options);
  // 1. Client bundles (minified) + stylesheets + fonts.
  await classifyRoutes(ctx);
  await emitExportCss(ctx);
  await setupCompat(ctx);
  await bundleExportRoutes(ctx);
  await bundleExportFlight(ctx);
  await selfHostExportFonts(ctx);
  // 2. Render every page (× each static param set).
  await renderAllPages(ctx);
  // 3. Copy public assets.
  await copyPublic(paths.publicDir, ctx.outDir);
  // Tear down the shared esbuild service the compat SSR build started (one-shot export).
  if (ctx.compat) await stopNextCompat();
  return { outDir: ctx.outDir, pages: ctx.pages, skipped: ctx.skipped };
}
