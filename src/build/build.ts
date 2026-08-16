// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.

import { ensureDir } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";
import { precompressDir } from "./precompress.ts";
import { scanRoutes } from "../router/manifest.ts";
import {
  bundleFlightEntry,
  bundleRoutes,
  generateRouteEntry,
  routeServerModules,
  routeSourceFiles,
  writeBundleOutput,
} from "./bundle.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "./next-compat-build.ts";
import { stopNextCompat } from "./next-compat.ts";
import { detectNextCompat } from "./next-compat-detect.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { routeNeedsHydration } from "./hydration.ts";
import { tailwindPaths } from "./tailwind.ts";
import { collectComponentSources, compileModules } from "./compiler.ts";

/** The file name of the app-wide Flight (RSC) client bundle. */
export const FLIGHT_BUNDLE_FILE = "flight.js";

export interface BuildResult {
  routes: Array<{ routePath: string; bundle: string }>;
  outDir: string;
}

export async function build(projectDir: string): Promise<BuildResult> {
  const paths: ProjectPaths = await resolveProject(projectDir);
  const manifest = await scanRoutes(paths.appDir);
  const finalClientDir = join(paths.outDir, "client");
  // Build into a staging dir and atomically swap it in only once the whole build
  // succeeds, so a mid-build failure never destroys the previous working build or
  // leaves a half-written client/. Starting from an empty staging dir also drops
  // stale content-hashed chunks from prior builds.
  const clientDir = join(paths.outDir, ".client.staging");
  await Deno.remove(clientDir, { recursive: true }).catch(() => {});
  await ensureDir(clientDir);

  const routes: BuildResult["routes"] = [];
  // next-compat mode: rewrite react→denext at bundle time so npm React libraries
  // render on denext's single React. The Flight/RSC boundary is preserved in compat
  // too (Stage 4b): a compat route reaching a `"use client"` island renders its
  // server components server-side and hydrates only the islands (react→denext
  // rewritten) via the compat flight bundle — so async data-fetching Server
  // Components work. Non-boundary compat routes needing interactivity fall back to
  // full-tree hydration.
  const compat = await detectNextCompat(paths);
  if (compat) process("next-compat mode: building react→denext SSR + client bundles");
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const boundaryRoutes = manifest.pages.filter((p) => flightRoutes.has(p.routePath));

  // CSS assets for the whole app: the import map lets `deno bundle` resolve every
  // `.css` import to its shim; per-route extraction produces the linked stylesheet.
  const css = await buildAppCss({
    projectDir: projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true,
    tailwind: tailwindPaths(projectDir, paths.config?.tailwind),
  });
  // Auto-memo compiler (experimental, opt-in): transform component modules and
  // redirect the client bundle to the transformed versions. Server rendering keeps
  // the originals — the transform is a no-op there — so SSR/hydration stay aligned.
  let compilerMap: Record<string, string> | undefined;
  if (paths.config?.experimental?.compiler) {
    process("auto-memo compiler: transforming components (experimental)");
    const sources = await collectComponentSources(projectDir);
    compilerMap = await compileModules(sources, { outDir: paths.outDir });
  }

  const cssImportMap = { ...css?.importMap, ...compilerMap };

  // Extract, write, and record a route's stylesheet (all routes, flight or not).
  async function emitRouteCss(route: typeof manifest.pages[number], id: string): Promise<void> {
    if (!css) return;
    const text = await extractRouteCss(routeSourceFiles(route), css as AppCss);
    if (text.trim().length > 0) {
      await Deno.writeTextFile(join(clientDir, `${id}.css`), text);
    }
  }

  // Emit every route's stylesheet (flight or not).
  for (const route of manifest.pages) {
    await emitRouteCss(route, routeId(route.routePath));
  }

  // Partition non-Flight routes: a route with no interactivity anywhere in its
  // tree ships ZERO client JavaScript (pure server-rendered HTML); the rest get a
  // hydration bundle. Boundary (Flight) routes are handled separately below.
  const nonFlight = manifest.pages.filter((r) => !flightRoutes.has(r.routePath));
  const staticRoutes: string[] = [];
  const clientRoutes: typeof nonFlight = [];
  for (const route of nonFlight) {
    if (await routeNeedsHydration(route)) clientRoutes.push(route);
    else staticRoutes.push(route.routePath);
  }
  if (staticRoutes.length > 0) {
    process(`${staticRoutes.length} static route(s) ship no client JS: ${staticRoutes.join(", ")}`);
  }

  // Bundle all interactive routes in ONE code-split pass so the client runtime
  // (imported by every route entry) is hoisted into a single shared chunk —
  // downloaded once and cached across client navigations — instead of being
  // inlined into each route's entry.
  if (!compat && clientRoutes.length > 0) {
    process(`bundling ${clientRoutes.length} route(s) -> client/ (shared runtime chunk)`);
    const out = await bundleRoutes(
      clientRoutes.map((route) => ({
        key: routeId(route.routePath),
        source: generateRouteEntry(route),
      })),
      { configPath: paths.configPath, minify: true, importMap: cssImportMap },
    );
    // Write shared + island chunks under their own (content-hashed) basenames;
    // identical chunks across routes collapse to one file.
    const entryBases = new Set(out.entries.values());
    for (const [name, code] of out.files) {
      if (!entryBases.has(name)) await Deno.writeTextFile(join(clientDir, name), code);
    }
    // Write each route's entry as `${id}.js`. Its chunk imports are by basename,
    // so renaming the entry file leaves them resolving correctly.
    for (const route of clientRoutes) {
      const id = routeId(route.routePath);
      const file = `${id}.js`;
      await Deno.writeTextFile(join(clientDir, file), out.files.get(out.entries.get(id)!)!);
      routes.push({ routePath: route.routePath, bundle: file });
    }
  }

  // The app-wide boundary manifest (client islands + server-action modules),
  // computed once and shared by the native Flight bundle AND the compat pipeline
  // (which bundles islands as react→denext-rewritten separately-loadable modules).
  // Crawl from every route's full server tree (page + layouts + templates + slots),
  // not just page files, so a client island imported only by a layout is found (H1).
  const hasFlight = boundaryRoutes.length > 0;
  const boundary = hasFlight
    ? await buildBoundaryManifest(
      paths.appDir,
      [...new Set(manifest.pages.flatMap(routeEntryFiles))],
      { exportsOf: importFunctionExports },
    )
    : null;

  // Native Flight bundle: only the app's `"use client"` modules, with `"use server"`
  // modules redirected to stubs (server code stripped). Compat builds its own
  // react→denext-rewritten flight bundle below.
  if (hasFlight && !compat) {
    process(`bundling Flight islands -> client/${FLIGHT_BUNDLE_FILE}`);
    const flightBundle = await bundleFlightEntry(boundary!, {
      configPath: paths.configPath,
      minify: true,
      importMap: cssImportMap,
    });
    await writeBundleOutput(clientDir, flightBundle, FLIGHT_BUNDLE_FILE);
  }

  // next-compat build: for every route, emit react→denext-rewritten SSR bundles
  // (re-exporting each module's default+named shape) so the SSR loader can render
  // npm React libraries on denext's single React, plus compat client bundles for
  // interactive routes. One prebuilt runtime is shared across server + client.
  const compatServerModules: Record<string, string> = {};
  if (compat) {
    // Bundle the route server modules (page/layout/…) AND every boundary island +
    // server-action module as separate entries in ONE code-split pass. As entries
    // they become their own chunks (never inlined into the page bundle), so a page's
    // reference to an island resolves — through the shared runtime chunk — to the
    // SAME module instance the SSR loader tags as a client reference. That shared
    // identity is what lets the Flight boundary hold across react→denext rewriting.
    const islandModules = boundary
      ? [...boundary.client.values()].map((r) => fromFileUrl(r.url))
      : [];
    const serverModules = boundary
      ? [...boundary.server.values()].map((r) => fromFileUrl(r.url))
      : [];
    const modules = [
      ...new Set([
        ...manifest.pages.flatMap(routeServerModules),
        ...islandModules,
        ...serverModules,
      ]),
    ];
    process(`next-compat: bundling ${modules.length} server module(s) -> server/`);
    const classComponents = paths.config?.classComponents ?? true;
    const moduleMap = await buildNextCompatModules({
      projectDir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      modules,
      minify: true,
      classComponents,
    });
    for (const [absSrc, absBundle] of moduleMap) {
      compatServerModules[relative(projectDir, absSrc)] = relative(paths.outDir, absBundle);
    }
    // Compat Flight bundle: react→denext-rewritten `"use client"` islands, keyed
    // by the same client ids the server tags — so boundary routes hydrate only
    // their islands (server components stay server-side).
    if (boundary) {
      process(`next-compat: bundling Flight islands -> client/${FLIGHT_BUNDLE_FILE}`);
      await buildNextCompatFlightEntry({
        projectDir,
        configPath: paths.configPath,
        outDir: paths.outDir,
        clientDir,
        boundary,
        flightFile: FLIGHT_BUNDLE_FILE,
        minify: true,
        classComponents,
      });
    }
    if (clientRoutes.length > 0) {
      process(`next-compat: bundling ${clientRoutes.length} client route(s) -> client/`);
      await buildNextCompatClientEntries({
        projectDir,
        configPath: paths.configPath,
        outDir: paths.outDir,
        clientDir,
        entries: clientRoutes.map((route) => ({
          id: routeId(route.routePath),
          source: generateRouteEntry(route),
        })),
        minify: true,
        classComponents,
      });
      for (const route of clientRoutes) {
        routes.push({ routePath: route.routePath, bundle: `${routeId(route.routePath)}.js` });
      }
    }
    await stopNextCompat();
  }

  const buildManifest = {
    version: 1,
    generatedRoutes: routes,
    flight: hasFlight,
    boundaryRoutes: boundaryRoutes.map((p) => p.routePath),
    // Routes that ship no client JS (pure server-rendered HTML). The prod server
    // reads this to skip both the hydration <script> and the missing-bundle check.
    staticRoutes,
    pages: manifest.pages.map((p) => p.routePath),
    api: manifest.api.map((a) => a.routePath),
    // next-compat: routes rendered via react→denext server bundles, and the
    // source-module → server-bundle map (paths relative to outDir) the prod
    // server rebuilds the loader from.
    nextCompat: compat,
    compatServerModules,
  };
  // Precompress the built client assets so `denext start` can serve gzip with no
  // per-request CPU (the output is immutable). Done on the staging dir so the
  // atomic swap below brings the `.gz` siblings in together with their bundles.
  const gzCount = await precompressDir(clientDir);
  if (gzCount > 0) process(`precompressed ${gzCount} client asset(s) -> .gz`);

  // The whole client build succeeded — atomically swap staging into place. Only
  // now is the previous working client/ touched; a rename is atomic on the same
  // filesystem, so `denext start` never observes a half-written directory.
  await Deno.remove(finalClientDir, { recursive: true }).catch(() => {});
  await Deno.rename(clientDir, finalClientDir);

  // Write the manifest via a temp file + rename so a reader never sees a partial
  // JSON document (and a crash mid-write leaves the previous manifest intact).
  const manifestPath = join(paths.outDir, "manifest.json");
  const manifestTmp = `${manifestPath}.tmp`;
  await Deno.writeTextFile(manifestTmp, JSON.stringify(buildManifest, null, 2));
  await Deno.rename(manifestTmp, manifestPath);

  process(`\nBuilt ${routes.length} route bundle(s) into ${paths.outDir}`);
  return { routes, outDir: paths.outDir };
}

function process(msg: string): void {
  console.log(`  ${msg}`);
}
