// The production server's startup compiler (./manifest.ts's `StartupCompile`): what `denext start`
// computes when the build did not record it — the client boundary (an import-graph crawl through
// `deno info`) and the server copies (the `"use cache"` / platform-file / inline-action compile).
// `denext start` passes it; a compiled app does not, so its binary embeds neither the crawler nor
// the compiler (swc) — every build it serves records both.

import { join } from "@std/path";
import { resolveCacheComponents } from "../../server/config.ts";
import type { ModuleLoader } from "../../server/types.ts";
import { computeBoundaryRoutes } from "../module-graph.ts";
import { appBoundaryManifest } from "../pipeline-shared.ts";
import { projectPlatformRedirects } from "../platform-extensions.ts";
import { projectInlineServerActionModules } from "../inline-server-action.ts";
import { createUseCacheLoader } from "../use-cache-loader.ts";
import type { ProjectPaths } from "../paths.ts";
import type { StartupCompile } from "./manifest.ts";

/**
 * The server render's loader over copies compiled now, for a native build that recorded none:
 * the web target's platform files, `"use cache"` (Cache Components) and inline `"use server"`
 * functions — clearing the copies of a previous run first (copy names key on source URL, not
 * content, so a stale copy could otherwise shadow edited source after a restart without a
 * rebuild). `base` itself when nothing needs a copy.
 *
 * @param paths The project paths.
 * @param base The underlying loader.
 * @returns The loader.
 */
async function startupLoader(paths: ProjectPaths, base: ModuleLoader): Promise<ModuleLoader> {
  const useCache = resolveCacheComponents(paths.config);
  const redirects = await projectPlatformRedirects(paths.projectDir, paths.config, "web");
  const inline = (await projectInlineServerActionModules(paths.projectDir)).length > 0;
  if (!useCache && !inline && Object.keys(redirects).length === 0) return base;
  const cacheDir = join(paths.outDir, "server-cache");
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  return createUseCacheLoader(base, {
    projectDir: paths.projectDir,
    cacheDir,
    redirects,
    useCache,
  });
}

/** `denext start`'s startup compiler. */
export const startupCompile: StartupCompile = {
  boundaryRoutes: (appDir, pages) => computeBoundaryRoutes(appDir, pages),
  boundaryManifest: (appDir, pages) => appBoundaryManifest(appDir, pages),
  loader: startupLoader,
};
