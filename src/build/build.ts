// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import { bundleFlightEntry, bundleRoute } from "./bundle.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
} from "./module-graph.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";

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

  for (const route of manifest.pages) {
    // Boundary routes hydrate from the app-wide Flight bundle. Never bundle
    // their whole tree — that would pull server-component code into the browser.
    if (flightRoutes.has(route.routePath)) continue;
    const id = routeId(route.routePath);
    const file = `${id}.js`;
    process(`bundling ${route.routePath} -> client/${file}`);
    const js = await bundleRoute(route, {
      configPath: paths.configPath,
      minify: true,
    });
    await Deno.writeTextFile(join(clientDir, file), js);
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
    const flightJs = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      minify: true,
    });
    await Deno.writeTextFile(join(clientDir, FLIGHT_BUNDLE_FILE), flightJs);
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
