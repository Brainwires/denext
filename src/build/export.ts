// Static site export (SSG): pre-render every page — including dynamic routes
// enumerated by `generateStaticParams` — to static HTML plus client bundles, in
// a directory any static host can serve.

import { copy, ensureDir, walk } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { augmentMetadataConventions } from "../server/augment-metadata.ts";
import { applyPlugins, runPluginBuildSteps } from "../plugin/mod.ts";
import { renderPage } from "../server/render-page.ts";
import { renderDocument } from "../server/document.ts";
import { routeNeedsHydration } from "./hydration.ts";
import { publicEnv } from "../runtime/public-env.ts";
import { setImageRuntimeConfig } from "../runtime/image.ts";
import { defaultLoader } from "../server/mod.ts";
import {
  collectedFontEntries,
  resetFonts,
  setSelfHostedFonts,
} from "../compat/next/font/registry.ts";
import { FONTS_PUBLIC_PREFIX, selfHostFonts } from "./self-host-fonts.ts";
import { createRequestContext, runWithContext } from "../server/request-context.ts";
import { tagClientModules } from "../runtime/client-reference.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import type { ModuleLoader, PageModule } from "../server/types.ts";
import type { RouteParams } from "../router/segments.ts";
import { type I18nConfig, peelLocale } from "../server/i18n.ts";
import { readSegmentConfig } from "../server/segment-config.ts";
import {
  bundleFlightEntry,
  bundleRoute,
  routeServerModules,
  routeSourceFiles,
  writeBundleOutput,
} from "./bundle.ts";
import { buildNextCompatModules } from "./next-compat-build.ts";
import { createNextCompatServerLoader, redirectBoundaryToCompat } from "./next-compat-loader.ts";
import { detectNextCompat } from "./next-compat-detect.ts";
import { stopNextCompat } from "./next-compat.ts";
import { nodeResolveEnabled } from "../server/config.ts";
import { isNotFound } from "../runtime/error-boundary.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { createUseCacheLoader } from "./use-cache-loader.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
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

async function pathIsDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Static export for a Pages Router app. Runs the `@denext/pages-router` plugin's
 * build step (prerenders `getStaticProps` pages to `.denext/pages-static` and bundles
 * each route's client entry to `.denext/pages-client`), then assembles a host-anywhere
 * `out/`: the prerendered HTML at the site root, the client bundles under
 * `_denext/pages/` (the `PAGES_PREFIX` the HTML references), and `public/` verbatim.
 *
 * Only pages that can be fully prerendered are emitted (as with `next export`); pages
 * needing a request (`getServerSideProps`, API routes, or a dynamic page without
 * `getStaticPaths`) are served by `denext start` instead — a note is printed for those.
 */
async function exportPagesRouter(
  paths: ProjectPaths,
  options: StaticExportOptions,
): Promise<StaticExportResult> {
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "export",
    load: defaultLoader,
  });
  await runPluginBuildSteps({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  });

  const outDir = join(paths.projectDir, options.outDir ?? "out");
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await ensureDir(outDir);

  // Prerendered HTML (+ props.json for soft-nav) → site root.
  const staticSrc = join(paths.outDir, "pages-static");
  if (await pathIsDir(staticSrc)) await copy(staticSrc, outDir, { overwrite: true });
  // Client bundles → `_denext/pages/` (matches the `PAGES_PREFIX` in the HTML).
  const clientSrc = join(paths.outDir, "pages-client");
  if (await pathIsDir(clientSrc)) {
    await copy(clientSrc, join(outDir, "_denext", "pages"), { overwrite: true });
  }
  // `public/` assets → site root.
  if (await pathIsDir(paths.publicDir)) {
    await copy(paths.publicDir, outDir, { overwrite: true });
  }

  // Count the emitted HTML pages.
  let pages = 0;
  for await (const entry of walk(outDir, { exts: ["html"], includeDirs: false })) {
    if (entry.isFile) pages++;
  }
  return { outDir, pages, skipped: [] };
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
  // SPA mode ("React but not Next"): export the single client bundle + HTML shell
  // (no route pre-render). deno desktop serves the resulting `out/` unchanged.
  if (paths.config?.mode === "spa") {
    return await exportSpa(paths, { outDir: options.outDir });
  }
  // Pages Router (no `app/` tree): the `@denext/pages-router` plugin owns the build.
  // Run its build step (prerenders `getStaticProps` pages + bundles client entries),
  // then assemble a static `out/` from the prerendered HTML, the client bundles, and
  // `public/`.
  if (!(await pathIsDir(paths.appDir))) {
    return await exportPagesRouter(paths, options);
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
    // Route entry sources are the import roots; crawling them finds stylesheets in
    // sibling workspace packages (outside `projectDir`) the walk can't reach.
    entryFiles: [...new Set(manifest.pages.flatMap(routeEntryFiles))],
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

  // next-compat: render the STATIC export through react→denext-rewritten SSR bundles,
  // the same way `dev`/`serve` do — so the static render resolves what the native loader
  // can't: `.mdx`/`.md` (compiled by the compat build's MDX loader) and `server-only`/
  // `client-only` (neutralized by the env-poison plugin). Without this the export renders
  // route modules via a bare Deno import and dies on the first `.mdx` or `server-only`.
  const compat = await detectNextCompat(paths);
  // In compat mode, the source→compat-bundle map, so the Flight boundary's refs can be
  // redirected to their compat bundles before they're imported for SSR tagging (importing
  // the SOURCE module would run npm code under Deno's native loader — e.g. a
  // styled-components `styled.div` at module scope — which the compat bundle resolves).
  let compatModuleMap: Map<string, string> | null = null;
  if (compat) {
    const compatBoundary = flightRoutes.size > 0
      ? await buildBoundaryManifest(
        paths.appDir,
        [...new Set(manifest.pages.flatMap(routeEntryFiles))],
        { exportsOf: importFunctionExports },
      )
      : null;
    const islandModules = compatBoundary
      ? [...compatBoundary.client.values()].map((r) => fromFileUrl(r.url))
      : [];
    const serverModules = compatBoundary
      ? [...compatBoundary.server.values()].map((r) => fromFileUrl(r.url))
      : [];
    const modules = [
      ...new Set([
        ...manifest.pages.flatMap(routeServerModules),
        ...islandModules,
        ...serverModules,
      ]),
    ];
    const moduleMap = await buildNextCompatModules({
      projectDir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      modules,
      minify: true,
      classComponents: paths.config?.classComponents ?? true,
      resolveAllNodeModules: nodeResolveEnabled(paths.config),
      mdxOptions: paths.config?.mdx,
      cssImportMap: css?.importMap,
    });
    // Route the render loader through the compat bundles, and point boundary refs at
    // their compat bundles so Flight island/action identity holds across the rewrite.
    load = createNextCompatServerLoader(load, { moduleMap });
    if (compatBoundary) redirectBoundaryToCompat(compatBoundary, moduleMap);
    compatModuleMap = moduleMap;
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
    // Redirect this boundary's refs to their compat bundles before tagging — tagging
    // imports each module for SSR, and the compat bundle resolves npm packages the way
    // the Flight bundle does (the source module can throw under Deno's native loader).
    // The Flight bundle above intentionally used the un-redirected (source) boundary.
    if (compatModuleMap) {
      redirectBoundaryToCompat(boundary, compatModuleMap);
    }
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

  // Self-host Google fonts for the static export, exactly as the prod build does — so a
  // static site never makes a runtime request to fonts.googleapis.com. Force-load every
  // route module so its `next/font` loaders register, collect the stylesheets, download
  // them under out/_denext/fonts (where a static host serves FONTS_PUBLIC_PREFIX), and
  // install the map; `renderFontStyles` then inlines the local `@font-face` rather than a
  // Google <link>. Best-effort: an unfetchable font (offline build) stays a runtime link.
  resetFonts();
  const fontModules = new Set<string>();
  for (const p of manifest.pages) {
    fontModules.add(p.filePath);
    for (const layout of p.layoutChain) fontModules.add(layout);
  }
  for (const fp of fontModules) {
    try {
      await load(fp);
    } catch { /* module needs a request context / failed to load → skip its fonts */ }
  }
  const fontEntries = collectedFontEntries().map(([url, meta]) => ({ url, subsets: meta.subsets }));
  if (fontEntries.length > 0) {
    setSelfHostedFonts(
      await selfHostFonts(fontEntries, join(outDir, "_denext", "fonts"), FONTS_PUBLIC_PREFIX),
    );
  }

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
        let html: string;
        try {
          html = await renderStatic(
            route,
            localeParams,
            pathname,
            clientEntryFor,
            load,
            isBoundary,
            styleHrefsFor,
            manifest,
            options.i18n,
          );
        } catch (err) {
          // A route (or param) that renders to `notFound()` with no not-found boundary
          // is statically a 404 — skip its file (the host serves its own 404) rather than
          // aborting the whole export, mirroring the dynamic-without-params skip above.
          // Real errors and redirect()s still bubble.
          if (isNotFound(err)) {
            skipped.push(pathname);
            console.warn(`  skip ${pathname} — renders notFound()`);
            continue;
          }
          throw err;
        }
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

  // Tear down the shared esbuild service the compat SSR build started (one-shot export).
  if (compat) await stopNextCompat();

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
  manifest?: RouteManifest,
  i18n?: I18nConfig,
): Promise<string> {
  const request = new Request(`http://localhost${pathname}`);
  const ctx = createRequestContext(request);
  return runWithContext(ctx, async () => {
    const rendered = await renderPage({ route, params }, request, load, { flight });
    // Apply the same file-convention / hreflang augmentation the served path does.
    // Absolute URLs resolve against the page's metadataBase (there is no request
    // Host in a static export); with no metadataBase, og:image stays relative and
    // hreflang/canonical are skipped (they require an absolute URL).
    if (manifest) {
      const base = rendered.metadata.metadataBase;
      augmentMetadataConventions(rendered.metadata, {
        manifest,
        route,
        i18n,
        localeInfo: i18n ? peelLocale(pathname, i18n) : null,
        absolutize: (path) => {
          if (!base) return null;
          try {
            return new URL(path, base).href;
          } catch {
            return null;
          }
        },
      });
    }
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
