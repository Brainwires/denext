// Production server, stage 3: the module loader, middleware, instrumentation, config
// rules, cache store, the `createApp` handler and the Live hub.

import { join } from "@std/path";
import { timed } from "../../runtime/timing.ts";
import { getPluginRequestHandler } from "../../plugin/mod.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { createApp } from "../../server/app.ts";
import {
  cacheStoreKind,
  PageCache,
  resolveDefaultCacheStore,
  sweepOtherBuildPages,
} from "../../server/cache.ts";
import {
  configuredDesktopAppOrigin,
  resolveCacheComponents,
  resolveConfigRules,
  resolveLive,
  resolveServerOptions,
  resolveStreaming,
} from "../../server/config.ts";
import {
  loadInstrumentation,
  runRegister,
  setNextRuntimeEnv,
} from "../../server/instrumentation.ts";
import { bootScheduledTasks } from "../../server/task-loader.ts";
import { installLiveHub } from "../../server/live.ts";
import { sameOriginUpgrade } from "../../server/origin-check.ts";
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
 * files while SSR renders on the single denext React. Cache Components (opt-in)
 * wraps it so `"use cache"` directives compile into server-side caching — clearing any
 * transformed copies from a previous run first (copy names key on source URL, not
 * content, so a stale copy could otherwise shadow edited source after a restart without
 * a rebuild).
 */
async function prodLoader(paths: ProjectPaths, info: BuildInfo): Promise<ModuleLoader> {
  let load: ModuleLoader = defaultLoader;
  const compat = info.nextCompat && info.compatModuleMap.size > 0;
  if (compat) {
    load = createNextCompatServerLoader(load, { moduleMap: info.compatModuleMap });
  }
  // A compat bundle already carries the `"use cache"` transform (applied at bundle time, so
  // the module stays inside the react→denext bundle); the runtime rewrite is for native apps.
  if (resolveCacheComponents(paths.config) && !compat) {
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

/**
 * Import every route's page + layout modules before the server listens, so a large app's
 * first request doesn't spend its whole timeout budget loading a module graph (shadcn/ui's docs
 * page: 32 s of module evaluation → a 503 on first hit). A module that fails to import is left
 * to the request path, which reports the error properly.
 */
async function warmRouteModules(manifest: RouteManifest, load: ModuleLoader): Promise<void> {
  const files = new Set<string>();
  for (const p of manifest.pages) {
    files.add(p.filePath);
    for (const layout of p.layoutChain) files.add(layout);
  }
  await Promise.all([...files].map((f) => load(f).catch(() => undefined)));
}

/**
 * Whether this server may delete other builds' pages from its page store. Always for a store
 * only this build uses: the in-memory store, or the default node:sqlite file in this build's
 * own `.denext`. For a store other servers may share (a custom store, or an explicit
 * `cache.path`), only when the build id was pinned with `DENEXT_BUILD_ID`: replicas built
 * separately with random ids would otherwise delete each other's live pages on every
 * restart. With a pinned id, the replicas of a release share it, so only other releases'
 * pages go (during a rolling deploy an old replica loses its cache once — misses, never wrong
 * content).
 */
export function mayOwnPageStore(
  info: Pick<BuildInfo, "buildIdPinned">,
  kind: ReturnType<typeof cacheStoreKind>,
  explicitPath: boolean,
): boolean {
  if (info.buildIdPinned) return true;
  return kind === "memory" || (kind === "sqlite" && !explicitPath);
}

/**
 * Once, after startup and off the request path (the promise is not awaited): delete the page
 * cache's entries of other builds and older formats, which this build never reads (see
 * `PageCache`) but which would otherwise occupy the store until its eviction reached them.
 * `DENEXT_DEBUG_CACHE=1` logs the count.
 */
function sweepStalePagesAfterStartup(paths: ProjectPaths, info: BuildInfo): void {
  const buildId = info.buildId;
  if (!buildId || !mayOwnPageStore(info, cacheStoreKind(), !!paths.config?.cache?.path)) return;
  void Promise.resolve().then(() => sweepOtherBuildPages(buildId));
}

/**
 * Build the request handler: middleware, instrumentation (`NEXT_RUNTIME`, `register()`
 * once at boot, `onRequestError`, `onRequest`), the denext.config redirect/rewrite/header rules, the
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
  await timed("warmRouteModules", () => warmRouteModules(manifest, load));
  const middlewareRunner = await loadMiddleware(paths, load);
  setNextRuntimeEnv();
  const instrumentation = await loadInstrumentation(paths.instrumentationPath);
  await runRegister(instrumentation);
  // Discover tasks/ and register cron schedules (Deno.cron on Deploy, else a userland tick). The
  // scheduler lives for the server process (created once here); the disposer is not retained.
  await bootScheduledTasks(paths.projectDir, paths.config ?? undefined, paths.outDir);
  const rules = await resolveConfigRules(paths.config);
  await resolveDefaultCacheStore(
    paths.config?.cache?.path
      ? paths.config.cache
      : { ...paths.config?.cache, path: join(paths.outDir, "cache.db") },
  );
  sweepStalePagesAfterStartup(paths, info);
  const appHandler = createApp({
    getManifest: () => manifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor: assets.clientEntryFor,
    styleHrefsFor: assets.styleHrefsFor,
    globalErrorEntry: assets.globalErrorEntry,
    matchExternal: getPluginRequestHandler(),
    getMiddleware: () => middlewareRunner,
    onRequestError: instrumentation.onRequestError,
    onRequest: instrumentation.onRequest,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: rules.redirects,
    rewrites: rules.rewrites,
    headerRules: rules.headers,
    // ISR for routes opting in via revalidate/dynamic, keyed to this build (a redeploy's pages
    // must not be served from the previous build's entries: their client chunks are gone).
    pageCache: new PageCache(info.buildId),
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
    cacheComponents: resolveCacheComponents(paths.config),
    csp: paths.config?.csp,
    streaming: resolveStreaming(paths.config),
    hsts: paths.config?.hsts,
    publicEnvKeys: info.publicEnvKeys,
    apiBatch: paths.config?.apiBatch,
    apiMaxBodyBytes: paths.config?.apiMaxBodyBytes,
    cors: paths.config?.cors,
    appLinks: paths.config?.appLinks,
    // canonicalOrigin / trustForwardedHeaders / requestTimeout / maxConcurrency /
    // slotBackstop / actionMaxBodyBytes / cacheKeyParams — config, else their env vars.
    ...resolveServerOptions(paths.config),
  });
  if (flightRoutes.size > 0) {
    // Strict same-origin for the Live handshake; a Deno Desktop window's own
    // `desktop.app.origin` (exactly) counts as same-origin.
    const desktopAppOrigin = configuredDesktopAppOrigin(paths.config);
    installLiveHub({
      appHandler,
      originAllowed: (req) => sameOriginUpgrade(req, desktopAppOrigin),
      config: resolveLive(paths.config),
    });
  }
  return appHandler;
}
