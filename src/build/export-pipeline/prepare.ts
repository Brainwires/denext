// Static export, stage 0: the non-App-Router exports and the export context setup.

import { copy, ensureDir, walk } from "@std/fs";
import { join } from "@std/path";
import { runPluginBuildSteps } from "../../plugin/mod.ts";
import { scanRoutes } from "../../router/manifest.ts";
import { defaultLoader } from "../../server/mod.ts";
import type { ModuleLoader } from "../../server/types.ts";
import type { ProjectPaths } from "../paths.ts";
import { dirExists, setupPlugins } from "../pipeline-shared.ts";
import { exportSpa } from "../spa.ts";
import { createUseCacheLoader } from "../use-cache-loader.ts";
import type { ExportContext, StaticExportOptions, StaticExportResult } from "./context.ts";

/** Copy `src` into `dest` when `src` is a directory. */
async function copyDirIfPresent(src: string, dest: string): Promise<void> {
  if (await dirExists(src)) await copy(src, dest, { overwrite: true });
}

/** Count the `.html` files under `dir`. */
async function countHtml(dir: string): Promise<number> {
  let pages = 0;
  for await (const entry of walk(dir, { exts: ["html"], includeDirs: false })) {
    if (entry.isFile) pages++;
  }
  return pages;
}

/**
 * Static export for a Pages Router app. Runs the `@denext/pages-router` plugin's build
 * step (prerenders `getStaticProps` pages to `.denext/pages-static` and bundles each
 * route's client entry to `.denext/pages-client`), then assembles a host-anywhere `out/`:
 * the prerendered HTML at the site root, the client bundles under `_denext/pages/` (the
 * `PAGES_PREFIX` the HTML references), and `public/` verbatim.
 *
 * Only pages that can be fully prerendered are emitted (as with `next export`); pages
 * needing a request (`getServerSideProps`, API routes, or a dynamic page without
 * `getStaticPaths`) are served by `denext start` instead — a note is printed for those.
 */
async function exportPagesRouter(
  paths: ProjectPaths,
  options: StaticExportOptions,
): Promise<StaticExportResult> {
  await setupPlugins(paths, "export");
  await runPluginBuildSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  });
  const outDir = join(paths.projectDir, options.outDir ?? "out");
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await ensureDir(outDir);
  // Prerendered HTML (+ props.json for soft-nav) → site root; client bundles →
  // `_denext/pages/` (matches the `PAGES_PREFIX` in the HTML); `public/` → site root.
  await copyDirIfPresent(join(paths.outDir, "pages-static"), outDir);
  await copyDirIfPresent(join(paths.outDir, "pages-client"), join(outDir, "_denext", "pages"));
  await copyDirIfPresent(paths.publicDir, outDir);
  return { outDir, pages: await countHtml(outDir), skipped: [] };
}

/**
 * The exports that bypass the App Router pipeline, or null when the app has an `app/`
 * tree: SPA mode exports the single client bundle + HTML shell (no route pre-render; deno
 * desktop serves the resulting `out/` unchanged); an app with no `app/` dir is a Pages
 * Router app, whose plugin owns the build.
 */
export async function exportWithoutAppRouter(
  paths: ProjectPaths,
  options: StaticExportOptions,
): Promise<StaticExportResult | null> {
  if (paths.config?.mode === "spa") return await exportSpa(paths, { outDir: options.outDir });
  if (await dirExists(paths.appDir)) return null;
  return await exportPagesRouter(paths, options);
}

/**
 * Cache Components (experimental): wrap the loader so `"use cache"` directives compile
 * into server-side caching during the export render. Clears any stale transformed copies
 * from a previous run first (names key on source URL).
 */
async function exportLoader(paths: ProjectPaths): Promise<ModuleLoader> {
  if (!paths.config?.experimental?.cacheComponents) return defaultLoader;
  const cacheDir = join(paths.outDir, "server-cache");
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  return createUseCacheLoader(defaultLoader, { projectDir: paths.projectDir, cacheDir });
}

/** Set up plugins, scan the routes, resolve i18n and the output dirs, pick the loader. */
export async function prepareExport(
  projectDir: string,
  paths: ProjectPaths,
  options: StaticExportOptions,
): Promise<ExportContext> {
  await setupPlugins(paths, "export");
  const manifest = await scanRoutes(paths.appDir);
  const outDir = join(projectDir, options.outDir ?? "out");
  const clientOut = join(outDir, "_denext", "client");
  await ensureDir(clientOut);
  return {
    projectDir,
    paths,
    manifest,
    // Fall back to the project's denext.config i18n when not passed explicitly.
    i18n: options.i18n ?? paths.i18n ?? undefined,
    outDir,
    clientOut,
    load: await exportLoader(paths),
    flightRoutes: new Set(),
    staticRoutes: new Set(),
    cssRoutes: new Set(),
    css: null,
    compat: false,
    compatModuleMap: null,
    pages: 0,
    skipped: [],
  };
}
