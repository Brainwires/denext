// The default module loader, apart from `src/server/mod.ts` so the CLI's project-verb discovery
// (`denext commands`, completions) can load a project's plugins without importing the server.

import { toFileUrl } from "@std/path";
import { inRootContext } from "./root-context.ts";
import type { ModuleLoader } from "./types.ts";

/**
 * Default module loader: dynamic import by absolute file path. A module is shared by every
 * request, so it is loaded outside the request that first asks for it: its top-level code, and
 * anything that code schedules, never runs as that request.
 */
export const defaultLoader: ModuleLoader = (filePath): Promise<unknown> => {
  const url = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
  return inRootContext(() => import(url));
};

/**
 * `load`, answering a path it has loaded before with the same promise instead of loading it again.
 * For the production server, whose module files never change while it runs: a route's page and
 * layouts are asked for on every request, and each call would otherwise resolve the path to a
 * URL and go through `import()` again (Deno's module map already holds the module; only the work
 * of reaching it repeats). A load that fails is forgotten, so the next call retries it, as a
 * fresh `import()` would. Never for the dev server: its loaders load an edited file anew.
 *
 * @param load The loader to memoize.
 * @returns A loader that loads each path at most once while its load has not failed.
 */
export function memoizeLoader(load: ModuleLoader): ModuleLoader {
  const loads = new Map<string, Promise<unknown>>();
  return (filePath) => {
    let pending = loads.get(filePath);
    if (pending === undefined) {
      pending = load(filePath);
      loads.set(filePath, pending);
      const settled = pending;
      settled.catch(() => {
        if (loads.get(filePath) === settled) loads.delete(filePath);
      });
    }
    return pending;
  };
}
