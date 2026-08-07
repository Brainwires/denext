// Production build: pre-bundle each page route's client entry into the output
// directory, and write a build manifest.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import { bundleRoute } from "./bundle.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";

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

  for (const route of manifest.pages) {
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

  const buildManifest = {
    version: 1,
    generatedRoutes: routes,
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
