// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import { bundleFlightEntry, bundleRoute, routeSourceFiles, writeBundleOutput } from "./bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
} from "./module-graph.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
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
  const clientDir = join(paths.outDir, "client");
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

  for (const route of manifest.pages) {
    const id = routeId(route.routePath);
    await emitRouteCss(route, id);
    // Boundary routes hydrate from the app-wide Flight bundle. Never bundle
    // their whole tree — that would pull server-component code into the browser.
    if (flightRoutes.has(route.routePath)) continue;
    const file = `${id}.js`;
    process(`bundling ${route.routePath} -> client/${file}`);
    const bundle = await bundleRoute(route, {
      configPath: paths.configPath,
      minify: true,
      importMap: cssImportMap,
    });
    await writeBundleOutput(clientDir, bundle, file);
    routes.push({ routePath: route.routePath, bundle: file });
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
    pages: manifest.pages.map((p) => p.routePath),
    api: manifest.api.map((a) => a.routePath),
  };
  await Deno.writeTextFile(
    join(paths.outDir, "manifest.json"),
    JSON.stringify(buildManifest, null, 2),
  );

  process(`\nBuilt ${routes.length} route bundle(s) into ${paths.outDir}`);
  return { routes, outDir: paths.outDir };
}

function process(msg: string): void {
  console.log(`  ${msg}`);
}
