// Production server, stage 3: the module loader, middleware, instrumentation, config
// rules, cache store, the `createApp` handler and the Live hub.

import { join } from "@std/path";
import { getPluginRequestHandler } from "../../plugin/mod.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { createApp } from "../../server/app.ts";
import { PageCache, resolveDefaultCacheStore } from "../../server/cache.ts";
import { resolveConfigRules, resolveLive, resolveStreaming } from "../../server/config.ts";
import {
  loadInstrumentation,
  runRegister,
  setNextRuntimeEnv,
} from "../../server/instrumentation.ts";
import { installLiveHub } from "../../server/live.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../../server/middleware.ts";
import { defaultLoader } from "../../server/mod.ts";
import type { ModuleLoader } from "../../server/types.ts";
import { createNextCompatServerLoader } from "../next-compat-loader.ts";
import type { ProjectPaths } from "../paths.ts";
import { createUseCacheLoader } from "../use-cache-loader.ts";
import type { AssetResolvers } from "./assets.ts";
import type { BuildInfo, FlightBoundary } from "./manifest.ts";

/**
 * The SSR module loader. next-compat redirects route source modules to their react→denext
 * server bundles (innermost, above defaultLoader) so use-cache/native both operate on real
 * files while SSR renders on the single denext React. Cache Components (experimental)
 * wraps it so `"use cache"` directives compile into server-side caching — clearing any
 * transformed copies from a previous run first (copy names key on source URL, not
 * content, so a stale copy could otherwise shadow edited source after a restart without
 * a rebuild).
 */
async function prodLoader(paths: ProjectPaths, info: BuildInfo): Promise<ModuleLoader> {
  let load: ModuleLoader = defaultLoader;
  if (info.nextCompat && info.compatModuleMap.size > 0) {
    load = createNextCompatServerLoader(load, { moduleMap: info.compatModuleMap });
  }
  if (paths.config?.experimental?.cacheComponents) {
    const cacheDir = join(paths.outDir, "server-cache");
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
    load = createUseCacheLoader(load, { projectDir: paths.projectDir, cacheDir });
  }
  return load;
}

/** Load middleware once at startup. */
async function loadMiddleware(paths: ProjectPaths, load: ModuleLoader): Promise<MiddlewareRunner> {
  if (!paths.middlewarePath) return null;
  const mod = await load(paths.middlewarePath);
  return createMiddlewareRunner(mod as never);
}

/** Strict same-origin check for the Live WebSocket handshake. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Build the request handler: middleware, instrumentation (`NEXT_RUNTIME`, `register()`
 * once at boot, `onRequestError`), the denext.config redirect/rewrite/header rules, the
 * durable default cache store (node:sqlite in THIS project's .denext — separate apps never
 * share/poison one cache; fails safe to in-memory) and `createApp`. Live Server
 * Components: the WebSocket hub is mounted only when the app has a Flight route (only
 * Flight routes can carry a `<Live>` boundary); the socket's own cookies still gate
 * every push.
 */
export async function createProdApp(
  paths: ProjectPaths,
  manifest: RouteManifest,
  info: BuildInfo,
  { flightRoutes, boundary }: FlightBoundary,
  assets: AssetResolvers,
): Promise<(request: Request) => Promise<Response>> {
  const load = await prodLoader(paths, info);
  const middlewareRunner = await loadMiddleware(paths, load);
  setNextRuntimeEnv();
  const instrumentation = await loadInstrumentation(paths.instrumentationPath);
  await runRegister(instrumentation);
  const rules = await resolveConfigRules(paths.config);
  await resolveDefaultCacheStore(
    paths.config?.cache?.path
      ? paths.config.cache
      : { ...paths.config?.cache, path: join(paths.outDir, "cache.db") },
  );
  const appHandler = createApp({
    getManifest: () => manifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor: assets.clientEntryFor,
    styleHrefsFor: assets.styleHrefsFor,
    matchExternal: getPluginRequestHandler(),
    getMiddleware: () => middlewareRunner,
    onRequestError: instrumentation.onRequestError,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: rules.redirects,
    rewrites: rules.rewrites,
    headerRules: rules.headers,
    pageCache: new PageCache(), // ISR for routes opting in via revalidate/dynamic
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
    cacheComponents: paths.config?.experimental?.cacheComponents,
    csp: paths.config?.csp,
    streaming: resolveStreaming(paths.config),
    hsts: paths.config?.hsts,
    publicEnvKeys: info.publicEnvKeys,
  });
  if (flightRoutes.size > 0) {
    installLiveHub({ appHandler, originAllowed: sameOrigin, config: resolveLive(paths.config) });
  }
  return appHandler;
}
