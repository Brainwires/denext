// Static export, stage 1: the client-side assets — route classification, stylesheets, the
// next-compat SSR bundles, the route + Flight client bundles, and self-hosted fonts.

import { join } from "@std/path";
import { setSelfHostedFonts } from "../../compat/next/font/registry.ts";
import { tagClientModules } from "../../runtime/client-reference.ts";
import { tagServerModules } from "../../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import { bundleFlightEntry, bundleRoute, routeSourceFiles, writeBundleOutput } from "../bundle.ts";
import { buildAppCss, extractRouteCss } from "../css.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { type BoundaryManifest, computeBoundaryRoutes, routeEntryFiles } from "../module-graph.ts";
import { buildNextCompatModules } from "../next-compat-build.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { createNextCompatServerLoader, redirectBoundaryToCompat } from "../next-compat-loader.ts";
import { routeId } from "../paths.ts";
import {
  appBoundaryManifest,
  collectPageFontEntries,
  compatBuildOptions,
  compatModuleList,
} from "../pipeline-shared.ts";
import { FONTS_PUBLIC_PREFIX, selfHostFonts } from "../self-host-fonts.ts";
import type { ExportContext } from "./context.ts";

/**
 * Classify the routes: boundary routes (their graph reaches a `"use client"` module)
 * share one Flight bundle (server-component code never enters it); a route with no
 * interactivity anywhere in its tree is STATIC — it ships zero client JS and no hydration
 * script (the same classification the production build makes); the rest get a whole-tree
 * bundle.
 */
export async function classifyRoutes(ctx: ExportContext): Promise<void> {
  const flight = await computeBoundaryRoutes(ctx.paths.appDir, ctx.manifest.pages);
  for (const r of flight) ctx.flightRoutes.add(r);
  for (const route of ctx.manifest.pages) {
    if (flight.has(route.routePath)) continue;
    if (!(await routeNeedsHydration(route))) ctx.staticRoutes.add(route.routePath);
  }
}

/** CSS assets: import map for `deno bundle`, per-route extraction for the link. */
export async function emitExportCss(ctx: ExportContext): Promise<void> {
  const { manifest, paths } = ctx;
  ctx.css = await buildAppCss({
    projectDir: ctx.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true,
    // Route entry sources are the import roots; crawling them finds stylesheets in
    // sibling workspace packages (outside `projectDir`) the walk can't reach.
    entryFiles: [...new Set(manifest.pages.flatMap(routeEntryFiles))],
  });
  if (!ctx.css) return;
  for (const route of manifest.pages) {
    const text = await extractRouteCss(routeSourceFiles(route), ctx.css);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(ctx.clientOut, `${routeId(route.routePath)}.css`), text);
      ctx.cssRoutes.add(route.routePath);
    }
  }
}

/** The app-wide boundary manifest (crawled from every route's full server tree). */
function boundaryManifest(ctx: ExportContext): Promise<BoundaryManifest> {
  return appBoundaryManifest(ctx.paths.appDir, ctx.manifest.pages);
}

/**
 * next-compat: render the STATIC export through react→denext-rewritten SSR bundles, the
 * same way `dev`/`serve` do — so the static render resolves what the native loader can't:
 * `.mdx`/`.md` (compiled by the compat build's MDX loader) and `server-only`/`client-only`
 * (neutralized by the env-poison plugin). Without this the export renders route modules
 * via a bare Deno import and dies on the first `.mdx` or `server-only`. The Flight
 * boundary's refs are redirected to their compat bundles before they're imported for SSR
 * tagging (importing the SOURCE module would run npm code under Deno's native loader).
 */
export async function setupCompat(ctx: ExportContext): Promise<void> {
  ctx.compat = await detectNextCompat(ctx.paths);
  if (!ctx.compat) return;
  const boundary = ctx.flightRoutes.size > 0 ? await boundaryManifest(ctx) : null;
  const moduleMap = await buildNextCompatModules({
    ...compatBuildOptions(ctx.projectDir, ctx.paths, ctx.css?.importMap),
    modules: compatModuleList(ctx.manifest.pages, boundary),
  });
  // Route the render loader through the compat bundles, and point boundary refs at their
  // compat bundles so Flight island/action identity holds across the rewrite.
  ctx.load = createNextCompatServerLoader(ctx.load, { moduleMap });
  if (boundary) redirectBoundaryToCompat(boundary, moduleMap);
  ctx.compatModuleMap = moduleMap;
}

/** Client bundles (minified): a whole-tree bundle per isomorphic (non-Flight, non-static) route. */
export async function bundleExportRoutes(ctx: ExportContext): Promise<void> {
  for (const route of ctx.manifest.pages) {
    if (ctx.flightRoutes.has(route.routePath) || ctx.staticRoutes.has(route.routePath)) continue;
    const bundle = await bundleRoute(route, {
      configPath: ctx.paths.configPath,
      minify: true,
      importMap: ctx.css?.importMap,
    });
    await writeBundleOutput(ctx.clientOut, bundle, `${routeId(route.routePath)}.js`);
  }
}

/**
 * The shared Flight bundle (`"use server"` modules redirected to stubs so server code is
 * stripped), then tag client islands (render as references) and server exports
 * (serialize as action refs) once, before rendering. In compat mode the boundary's refs
 * are redirected to their compat bundles before tagging — tagging imports each module for
 * SSR, and the compat bundle resolves npm packages the way the Flight bundle does (the
 * source module can throw under Deno's native loader). The Flight bundle itself
 * intentionally uses the un-redirected (source) boundary.
 */
export async function bundleExportFlight(ctx: ExportContext): Promise<void> {
  if (ctx.flightRoutes.size === 0) return;
  const boundary = await boundaryManifest(ctx);
  const flightBundle = await bundleFlightEntry(boundary, {
    configPath: ctx.paths.configPath,
    minify: true,
    importMap: ctx.css?.importMap,
  });
  await writeBundleOutput(ctx.clientOut, flightBundle, FLIGHT_BUNDLE_FILE);
  if (ctx.compatModuleMap) redirectBoundaryToCompat(boundary, ctx.compatModuleMap);
  await tagClientModules(boundary.client);
  await tagServerModules(boundary.server);
}

/**
 * Self-host Google fonts for the static export, exactly as the prod build does — so a
 * static site never makes a runtime request to fonts.googleapis.com. Force-load every
 * route module so its `next/font` loaders register, collect the stylesheets, download
 * them under out/_denext/fonts (where a static host serves FONTS_PUBLIC_PREFIX), and
 * install the map; `renderFontStyles` then inlines the local `@font-face` rather than a
 * Google <link>. Best-effort: an unfetchable font (offline build) stays a runtime link.
 */
export async function selfHostExportFonts(ctx: ExportContext): Promise<void> {
  const fontEntries = await collectPageFontEntries(ctx.manifest.pages, ctx.load);
  if (fontEntries.length === 0) return;
  setSelfHostedFonts(
    await selfHostFonts(fontEntries, join(ctx.outDir, "_denext", "fonts"), FONTS_PUBLIC_PREFIX),
  );
}
