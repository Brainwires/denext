// Static export, stage 1: the client-side assets — route classification, stylesheets, the
// next-compat SSR bundles, the route + Flight client bundles, and self-hosted fonts.

import { join } from "@std/path";
import { featureFlags, momentumSafeScrollEnabled } from "../../server/config.ts";
import { prodMinify } from "../minify.ts";
import { setSelfHostedFonts } from "../../compat/next/font/registry.ts";
import { tagClientModules } from "../../runtime/client-reference.ts";
import { tagServerModules } from "../../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";
import { clientTransforms } from "../build-pipeline/transforms.ts";
import { bundleFlightEntry, bundleRoute, routeSourceFiles, writeBundleOutput } from "../bundle.ts";
import { buildAppCss, extractRouteCss, primeCssGraph } from "../css.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { type BoundaryManifest, computeBoundaryRoutes, routeEntryFiles } from "../module-graph.ts";
import { buildNextCompatFlightEntry, buildNextCompatModules } from "../next-compat-build.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { boundaryRefLoader, createNextCompatServerLoader } from "../next-compat-loader.ts";
import { routeId } from "../paths.ts";
import { stylesheetImportMap } from "../platform-imports.ts";
import {
  appBoundaryManifest,
  collectPageFontEntries,
  compatBuildOptions,
  compatModuleList,
} from "../pipeline-shared.ts";
import { FONTS_PUBLIC_PREFIX, selfHostFonts } from "../self-host-fonts.ts";
import { exportBuildDir, exportClientResolution, type ExportContext } from "./context.ts";
import { npmBoundaryByImporter } from "../npm-boundary.ts";

/**
 * Classify the routes: boundary routes (their graph reaches a `"use client"` module)
 * share one Flight bundle (server-component code never enters it); a route with no
 * interactivity anywhere in its tree is STATIC — it ships zero client JS and no hydration
 * script (the same classification the production build makes); the rest get a whole-tree
 * bundle.
 */
export async function classifyRoutes(ctx: ExportContext): Promise<void> {
  // In compat mode the boundary includes `"use client"` files inside npm packages too.
  ctx.compat = await detectNextCompat(ctx.paths);
  const flight = await computeBoundaryRoutes(ctx.paths.appDir, ctx.manifest.pages, {
    npm: ctx.compat ? npmBoundaryByImporter : undefined,
  });
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
    minify: prodMinify(),
    // Route entry sources are the import roots; crawling them finds stylesheets in
    // sibling workspace packages (outside `projectDir`) the walk can't reach.
    entryFiles: [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    // A next-compat app's esbuild bundles probe the target's platform files, so its stylesheet
    // crawl resolves them through their redirects (the native path's crawls already do).
    graph: ctx.compat
      ? await stylesheetImportMap(
        ctx.projectDir,
        paths.config,
        ctx.platform,
        join(paths.outDir, "platform-imports", `css-${ctx.platform}`),
      )
      : undefined,
  });
  if (!ctx.css) return;
  await primeCssGraph(
    [...new Set(manifest.pages.flatMap(routeSourceFiles))],
    ctx.css.appConfigPath,
    ctx.css.graph,
  );
  for (const route of manifest.pages) {
    const text = await extractRouteCss(routeSourceFiles(route), ctx.css);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(ctx.clientOut, `${routeId(route.routePath)}.css`), text);
      ctx.cssRoutes.add(route.routePath);
    }
  }
}

/** Each export's boundary manifest, crawled once ({@linkcode boundaryManifest}). */
const boundaries = new WeakMap<ExportContext, Promise<BoundaryManifest>>();

/** The app-wide boundary manifest (crawled from every route's full server tree). */
function boundaryManifest(ctx: ExportContext): Promise<BoundaryManifest> {
  let boundary = boundaries.get(ctx);
  if (!boundary) {
    boundary = appBoundaryManifest(ctx.paths.appDir, ctx.manifest.pages, {
      npm: ctx.compat ? npmBoundaryByImporter : undefined,
    });
    boundaries.set(ctx, boundary);
  }
  return boundary;
}

/**
 * The next-compat bundling options for the export. Its intermediates (the server bundle under
 * `server/`, the prebuilt client runtime) go to the export's own build dir
 * ({@linkcode exportBuildDir}), never the `.denext/server/` a `denext build` left for `denext
 * start`: the export bundles another module list (no middleware), so rebuilding that bundle in
 * place renumbered its module exports under the build's manifest.
 */
function exportCompatOptions(ctx: ExportContext) {
  return {
    ...compatBuildOptions(
      ctx.projectDir,
      ctx.paths,
      ctx.css?.importMap,
      ctx.clientOut,
      ctx.platform,
    ),
    outDir: exportBuildDir(ctx.paths),
  };
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
    ...exportCompatOptions(ctx),
    modules: compatModuleList(ctx.manifest.pages, boundary, ctx.manifest.api),
  });
  // Route the render loader through the compat bundles, and point boundary refs at their
  // compat bundles so Flight island/action identity holds across the rewrite.
  ctx.load = createNextCompatServerLoader(ctx.load, { moduleMap });
  ctx.compatModuleMap = moduleMap;
}

/**
 * The client transforms (auto-memo, qrl, AsyncContext, feature folds), computed by the same
 * function `denext build` runs, into the export's own build dir. A next-compat export bundles
 * with esbuild, which folds flags itself and reads none of them (as in the build).
 */
export async function exportClientTransforms(ctx: ExportContext): Promise<void> {
  if (ctx.compat) return;
  ctx.transforms = await clientTransforms(ctx, exportBuildDir(ctx.paths));
}

/** Client bundles (minified): a whole-tree bundle per isomorphic (non-Flight, non-static) route. */
export async function bundleExportRoutes(ctx: ExportContext): Promise<void> {
  for (const route of ctx.manifest.pages) {
    if (ctx.flightRoutes.has(route.routePath) || ctx.staticRoutes.has(route.routePath)) continue;
    // A whole-route bundle stubs the actions it imports, as the Flight bundle does.
    const server = (await boundaryManifest(ctx)).server;
    const bundle = await bundleRoute(route, {
      configPath: ctx.paths.configPath,
      momentumSafeScroll: momentumSafeScrollEnabled(ctx.paths.config),
      minify: prodMinify(),
      ...exportClientResolution(ctx, server),
      instrumentationClient: ctx.paths.instrumentationClientPath,
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
 * source module can throw under Deno's native loader). The Flight bundle itself uses the
 * un-redirected (source) boundary; in compat mode it is the compat (esbuild) Flight bundle.
 */
export async function bundleExportFlight(ctx: ExportContext): Promise<void> {
  if (ctx.flightRoutes.size === 0) return;
  const boundary = await boundaryManifest(ctx);
  if (ctx.compat) {
    // next-compat: the react→denext-rewritten Flight bundle, as `denext build` makes it — the
    // native one (`deno bundle` of the source islands) would bundle an npm library's own React
    // (and, for an npm island, Next's real `next/*` modules).
    await buildNextCompatFlightEntry({
      ...exportCompatOptions(ctx),
      clientDir: ctx.clientOut,
      boundary,
      flightFile: FLIGHT_BUNDLE_FILE,
      instrumentationClient: ctx.paths.instrumentationClientPath,
    });
  } else {
    const flightBundle = await bundleFlightEntry(boundary, {
      configPath: ctx.paths.configPath,
      momentumSafeScroll: momentumSafeScrollEnabled(ctx.paths.config),
      minify: prodMinify(),
      ...exportClientResolution(ctx, boundary.server),
      // Seed the feature-flag map on the native client, as the build does, so an un-folded
      // feature() call agrees with the server render.
      features: featureFlags(ctx.paths.config),
      instrumentationClient: ctx.paths.instrumentationClientPath,
    });
    await writeBundleOutput(ctx.clientOut, flightBundle, FLIGHT_BUNDLE_FILE);
  }
  // Tag through the (compat-aware) loader so the tagged instances are the ones the page
  // bundles reference.
  const load = boundaryRefLoader(ctx.load);
  await tagClientModules(boundary.client, load);
  await tagServerModules(boundary.server, load);
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
