// Static site export (SSG): pre-render every page — including dynamic routes
// enumerated by `generateStaticParams` — to static HTML plus client bundles, in
// a directory any static host can serve.
//
// The stages live under `./export-pipeline/` around one shared `ExportContext`: `prepare`
// (SPA / Pages Router exports, plugin setup, scan, dirs, loader), `assets` (route
// classification, stylesheets, next-compat SSR bundles, route + Flight bundles, fonts) and
// `render` (every page × param set × locale, then `public/`). This module runs them in order.

import { writePlatformStamp } from "./ota-manifest.ts";
import { runPluginBuildSteps } from "../plugin/mod.ts";
import { setImageRuntimeConfig } from "../runtime/image.ts";
import {
  bundleExportFlight,
  bundleExportRoutes,
  classifyRoutes,
  emitExportCss,
  exportClientTransforms,
  selfHostExportFonts,
  setupCompat,
} from "./export-pipeline/assets.ts";
import type {
  ExportContext,
  StaticExportOptions,
  StaticExportResult,
} from "./export-pipeline/context.ts";
import { setModuleGraphRedirects } from "./module-graph.ts";
import { exportWithoutAppRouter, finishExport, prepareExport } from "./export-pipeline/prepare.ts";
import { copyPublic, renderAllPages } from "./export-pipeline/render.ts";
import { stopNextCompat } from "./next-compat.ts";
import { resolveProject } from "./paths.ts";
import { writeMobileExportExtras } from "./mobile-export-extras.ts";
import { writeDesktopPreload } from "./desktop-preload.ts";

export type { StaticExportOptions, StaticExportResult } from "./export-pipeline/context.ts";

/** Bundle, render and write everything of one App Router export. */
async function renderExport(ctx: ExportContext): Promise<void> {
  const { paths } = ctx;
  // 1. Client bundles (minified) + stylesheets + fonts.
  await classifyRoutes(ctx);
  await emitExportCss(ctx);
  await setupCompat(ctx);
  // The client transforms `denext build` applies (one shared path), before any client bundle.
  await exportClientTransforms(ctx);
  await bundleExportRoutes(ctx);
  await bundleExportFlight(ctx);
  await selfHostExportFonts(ctx);
  // 2. Render every page (× each static param set).
  await renderAllPages(ctx);
  // 3. Copy public assets.
  await copyPublic(paths.publicDir, ctx.outDir);
  // 3b. Mobile extras: the appLinks association files and the Background Runner script.
  await writeMobileExportExtras(paths.projectDir, paths.config, ctx.outDir);
  // 3c. `desktop.preload`, bundled for the desktop runtime to inline first into every page.
  await writeDesktopPreload(paths, ctx.outDir);
  // 3c'. Plugin build steps; what they publish with `emitFile` lands at the export's root.
  await runPluginBuildSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  }, { emitDir: ctx.outDir });
  // 3d. A platform export names its target (an OTA manifest of it then does too).
  if (ctx.platform !== "web") await writePlatformStamp(ctx.outDir, ctx.platform);
  // Tear down the shared esbuild service the compat SSR build started (one-shot export).
  if (ctx.compat) await stopNextCompat();
  // 4. Everything rendered: swap the staging dir into `out/`.
  await finishExport(ctx);
}

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

  try {
    const ctx = await prepareExport(projectDir, paths, options);
    await renderExport(ctx);
    return { outDir: ctx.finalOutDir, pages: ctx.pages, skipped: ctx.skipped };
  } finally {
    // The target's graph redirects belong to this export only.
    setModuleGraphRedirects(null);
  }
}
