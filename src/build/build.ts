// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import {
  bundleFlightEntry,
  bundleRoutes,
  generateRouteEntry,
  routeSourceFiles,
  writeBundleOutput,
} from "./bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
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
  if (clientRoutes.length > 0) {
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

  // One Flight bundle for the whole app: only its `"use client"` modules, with
  // `"use server"` modules redirected to stubs (server code stripped).
  const hasFlight = boundaryRoutes.length > 0;
  if (hasFlight) {
    process(`bundling Flight islands -> client/${FLIGHT_BUNDLE_FILE}`);
    const boundary = await buildBoundaryManifest(
      paths.appDir,
      manifest.pages.map((p) => p.filePath),
      { exportsOf: importFunctionExports },
    );
    const flightBundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      minify: true,
      importMap: cssImportMap,
    });
    await writeBundleOutput(clientDir, flightBundle, FLIGHT_BUNDLE_FILE);
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
  };
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
