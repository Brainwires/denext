// Static site export (SSG): pre-render every page — including dynamic routes
// enumerated by `generateStaticParams` — to static HTML plus client bundles, in
// a directory any static host can serve.

import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { applyPlugins } from "../plugin/mod.ts";
import { renderPage } from "../server/render-page.ts";
import { renderDocument } from "../server/document.ts";
import { routeNeedsHydration } from "./hydration.ts";
import { publicEnv } from "../runtime/public-env.ts";
import { defaultLoader } from "../server/mod.ts";
import { createRequestContext, runWithContext } from "../server/request-context.ts";
import { tagClientModules } from "../runtime/client-reference.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import type { ModuleLoader, PageModule } from "../server/types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { I18nConfig } from "../server/i18n.ts";
import { readSegmentConfig } from "../server/segment-config.ts";
import { bundleFlightEntry, bundleRoute, routeSourceFiles, writeBundleOutput } from "./bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { createUseCacheLoader } from "./use-cache-loader.ts";
import { resolveProject, routeId } from "./paths.ts";
import { exportSpa } from "./spa.ts";

export interface StaticExportResult {
  /** Absolute path of the output directory. */
  outDir: string;
  /** Number of HTML pages written. */
  pages: number;
  /** Route paths skipped (dynamic without generateStaticParams). */
  skipped: string[];
}

export interface StaticExportOptions {
  /** Output directory name (relative to the project); defaults to "out". */
  outDir?: string;
  /** i18n config; when set, each page is emitted once per locale. */
  i18n?: I18nConfig;
}

/** Pre-render a denext app to a static, host-anywhere directory. */
export async function staticExport(
  projectDir: string,
  options: StaticExportOptions = {},
): Promise<StaticExportResult> {
  const paths = await resolveProject(projectDir);
  // SPA mode ("React but not Next"): export the single client bundle + HTML shell
  // (no route pre-render). deno desktop serves the resulting `out/` unchanged.
  if (paths.config?.mode === "spa") {
    return await exportSpa(paths, { outDir: options.outDir });
  }
  // Set up plugins before scanning so route-synthesizer plugins register in time.
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "export",
    load: defaultLoader,
  });
  const manifest = await scanRoutes(paths.appDir);
  // Fall back to the project's denext.config i18n when not passed explicitly.
  const i18n = options.i18n ?? paths.i18n ?? undefined;
  options = { ...options, i18n };
  const outDir = join(projectDir, options.outDir ?? "out");
  const clientOut = join(outDir, "_denext", "client");
  await ensureDir(clientOut);
  // Cache Components (experimental): wrap the loader so `"use cache"` directives
  // compile into server-side caching during the export render. Clear any stale
  // transformed copies from a previous run first (names key on source URL).
  let load: ModuleLoader = defaultLoader;
  if (paths.config?.experimental?.cacheComponents) {
    const cacheDir = join(paths.outDir, "server-cache");
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
    load = createUseCacheLoader(defaultLoader, { projectDir: paths.projectDir, cacheDir });
  }

  // 1. Client bundles (minified). Isomorphic routes get a whole-tree bundle;
  // boundary routes (their graph reaches a `"use client"` module) share one
  // Flight bundle (server-component code never enters it). A route with no
  // interactivity anywhere in its tree is STATIC — it ships zero client JS and no
  // hydration script (the same classification the production build makes).
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const staticRoutes = new Set<string>();
  for (const route of manifest.pages) {
    if (flightRoutes.has(route.routePath)) continue;
    if (!(await routeNeedsHydration(route))) staticRoutes.add(route.routePath);
  }

  // CSS assets: import map for `deno bundle`, per-route extraction for the link.
  const css = await buildAppCss({
    projectDir: projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true,
  });
  const cssRoutes = new Set<string>();
  for (const route of manifest.pages) {
    if (!css) break;
    const text = await extractRouteCss(routeSourceFiles(route), css as AppCss);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(clientOut, `${routeId(route.routePath)}.css`), text);
      cssRoutes.add(route.routePath);
    }
  }

  for (const route of manifest.pages) {
    if (flightRoutes.has(route.routePath) || staticRoutes.has(route.routePath)) continue;
    const bundle = await bundleRoute(route, {
      configPath: paths.configPath,
      minify: true,
      importMap: css?.importMap,
    });
    await writeBundleOutput(clientOut, bundle, `${routeId(route.routePath)}.js`);
  }
  if (flightRoutes.size > 0) {
    const boundary = await buildBoundaryManifest(
      paths.appDir,
      [...new Set(manifest.pages.flatMap(routeEntryFiles))],
      { exportsOf: importFunctionExports },
    );
    // Redirect "use server" modules to stubs so server code is stripped.
    const flightBundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      minify: true,
      importMap: css?.importMap,
    });
    await writeBundleOutput(clientOut, flightBundle, FLIGHT_BUNDLE_FILE);
    // Tag client islands (render as references) and server exports (serialize
    // as action refs) once, before rendering.
    await tagClientModules(boundary.client);
    await tagServerModules(boundary.server);
  }
  const clientEntryFor = (route: PageRoute): string | undefined =>
    staticRoutes.has(route.routePath)
      ? undefined // static route → no hydration script at all
      : flightRoutes.has(route.routePath)
      ? `/_denext/client/${FLIGHT_BUNDLE_FILE}`
      : `/_denext/client/${routeId(route.routePath)}.js`;
  const styleHrefsFor = (route: PageRoute): string[] | undefined =>
    cssRoutes.has(route.routePath)
      ? [`/_denext/client/${routeId(route.routePath)}.css`]
      : undefined;

  // 2. Render every page (× each static param set).
  let pages = 0;
  const skipped: string[] = [];
  for (const route of manifest.pages) {
    const mod = (await load(route.filePath)) as PageModule;
    // force-dynamic routes render per request; they can't be pre-rendered.
    if (readSegmentConfig(mod).dynamic === "force-dynamic") {
      skipped.push(route.routePath);
      console.warn(`  skip ${route.routePath} — export const dynamic = "force-dynamic"`);
      continue;
    }
    const paramSets = await paramSetsFor(route, load);
    if (paramSets === null) {
      skipped.push(route.routePath);
      console.warn(
        `  skip ${route.routePath} — dynamic route without generateStaticParams`,
      );
      continue;
    }
    for (const params of paramSets) {
      const basePath = fillPath(route, params);
      // With i18n, emit one variant per locale: the default locale unprefixed,
      // others under /<locale>/… . Without i18n, a single unprefixed page.
      const locales = options.i18n ? options.i18n.locales : [null];
      for (const loc of locales) {
        const isDefault = !options.i18n || loc === options.i18n.defaultLocale;
        const pathname = isDefault ? basePath : `/${loc}${basePath === "/" ? "" : basePath}`;
        const localeParams = options.i18n ? { ...params, locale: loc! } : params;
        const isBoundary = flightRoutes.has(route.routePath);
        const html = await renderStatic(
          route,
          localeParams,
          pathname,
          clientEntryFor,
          load,
          isBoundary,
          styleHrefsFor,
        );
        const file = pageFilePath(outDir, pathname);
        await ensureDir(dirname(file));
        await Deno.writeTextFile(file, html);
        console.log(`  ${pathname} -> ${file.slice(outDir.length + 1)}`);
        pages++;
      }
    }
  }

  // 3. Copy public assets.
  await copyPublic(paths.publicDir, outDir);

  return { outDir, pages, skipped };
}

/** Render one page to a full HTML document string. */
function renderStatic(
  route: PageRoute,
  params: RouteParams,
  pathname: string,
  clientEntryFor: (route: PageRoute) => string | undefined,
  load: ModuleLoader,
  flight = false,
  styleHrefsFor?: (route: PageRoute) => string[] | undefined,
): Promise<string> {
  const request = new Request(`http://localhost${pathname}`);
  const ctx = createRequestContext(request);
  return runWithContext(ctx, async () => {
    const rendered = await renderPage({ route, params }, request, load, { flight });
    return renderDocument({
      bodyHtml: rendered.html,
      metadata: rendered.metadata,
      viewport: rendered.viewport,
      clientEntry: clientEntryFor(route),
      styles: styleHrefsFor?.(route),
      hydration: { params, searchParams: "", pathname },
      flight: rendered.flight,
      islands: rendered.islands,
      signalState: rendered.signalState,
      publicEnv: publicEnv(),
    });
  });
}

/** Resolve the param sets to render for a route, or null to skip it. */
async function paramSetsFor(
  route: PageRoute,
  load: ModuleLoader,
): Promise<RouteParams[] | null> {
  const isDynamic = route.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return [{}];
  const mod = (await load(route.filePath)) as PageModule;
  if (typeof mod.generateStaticParams !== "function") return null;
  const sets = await mod.generateStaticParams();
  return sets.map((s) => ({ ...s }));
}

/** Fill a route pattern with params to produce a concrete pathname. */
function fillPath(route: PageRoute, params: RouteParams): string {
  const parts: string[] = [];
  for (const seg of route.pattern) {
    if (seg.kind === "static") parts.push(seg.value);
    else if (params[seg.value]) parts.push(params[seg.value]); // dynamic / catch-all
  }
  return "/" + parts.join("/");
}

/** Map a pathname to its output HTML file (clean-URL directories). */
function pageFilePath(outDir: string, pathname: string): string {
  if (pathname === "/") return join(outDir, "index.html");
  return join(outDir, pathname, "index.html");
}

/** Copy the public directory's contents into the output directory. */
async function copyPublic(publicDir: string, outDir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(publicDir)) {
      await copy(join(publicDir, entry.name), join(outDir, entry.name), {
        overwrite: true,
      });
    }
  } catch {
    // No public/ directory — nothing to copy.
  }
}
