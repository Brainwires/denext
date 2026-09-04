// Flight ("use client") routing decisions: whether a route reaches a client boundary,
// and the module loader that tags client references as they load.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import type { ModuleLoader } from "./types.ts";
import type { Directive } from "../build/directives.ts";
import { tagClientExports, tagClientModules } from "../runtime/client-reference.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { clientIdFor } from "../build/module-graph.ts";
import { toFileUrl } from "@std/path";
import type { AppConfig } from "./app-config.ts";

/** Does any module in this route carry a `"use client"` boundary directive? */
export function routeUsesBoundary(
  route: PageRoute,
  directives: Map<string, Directive> | undefined,
): boolean {
  if (!directives || directives.size === 0) return false;
  const paths = [route.filePath, ...route.layoutChain, ...route.templateChain];
  // The loading/error/not-found/forbidden/unauthorized boundaries the server
  // composes into the tree count too: an interactive `"use client"` boundary
  // (e.g. an error.tsx with a reset button) must render via Flight so the server
  // layout chain stays server-only. The isomorphic fallback value-imports that
  // chain and would leak its server-only imports (node:sqlite/node:async_hooks)
  // into the browser bundle.
  for (
    const boundary of [
      route.loading,
      route.error,
      route.notFound,
      route.forbidden,
      route.unauthorized,
    ]
  ) {
    if (boundary) paths.push(boundary);
  }
  for (const map of [route.slots, ...(route.layoutSlots ?? [])]) {
    if (!map) continue;
    for (const slot of Object.values(map)) {
      for (const sp of slot.pages) paths.push(sp.filePath);
    }
  }
  return paths.some((p) => directives.get(p) === "client");
}

/**
 * Wrap a loader so that, after loading a `"use client"` module, its exports are
 * tagged as client references (idempotent). The renderer then emits references
 * for them instead of expanding them into the Flight payload. Exported for the
 * static exporter, which renders pages outside the request handler.
 *
 * @param load The underlying module loader.
 * @param appDir The app directory (basis for stable client ids).
 * @param directives The manifest's per-module directive map.
 */
function taggingLoader(
  load: ModuleLoader,
  appDir: string,
  directives: Map<string, Directive>,
): ModuleLoader {
  return async (path: string) => {
    const mod = await load(path);
    if (directives.get(path) === "client" && mod && typeof mod === "object") {
      tagClientExports(
        mod as Record<string, unknown>,
        clientIdFor(appDir, toFileUrl(path).href),
      );
    }
    return mod;
  };
}

/**
 * Decide whether a page renders through Flight and which loader renders it. Flight is
 * used when enabled and this route reaches a client module: the build precomputes the
 * boundary routes + client modules; absent those, fall back to the route's own
 * convention directives. Graph-discovered client islands are tagged up front (imported
 * at most once) and "use server" exports auto-registered so action props serialize;
 * without a graph, a tagging loader tags client convention modules as they load.
 * Computed BEFORE the ISR cache-hit check so a (Flight PPR) cache hit resumes with tagged
 * client modules — a cold hit would otherwise carve no islands.
 */
export async function resolveFlightLoader(
  config: AppConfig,
  route: PageRoute,
  manifest: RouteManifest,
): Promise<{ useFlight: boolean; pageLoad: ModuleLoader }> {
  const useFlight = !!config.flight && !!config.appDir && (
    config.flightRoutes
      ? config.flightRoutes.has(route.routePath)
      : routeUsesBoundary(route, manifest.directives)
  );
  if (!useFlight) return { useFlight, pageLoad: config.load };
  if (!config.flightClients) {
    return {
      useFlight,
      pageLoad: taggingLoader(config.load, config.appDir!, manifest.directives!),
    };
  }
  await tagClientModules(config.flightClients);
  if (config.flightServers) await tagServerModules(config.flightServers);
  return { useFlight, pageLoad: config.load };
}
