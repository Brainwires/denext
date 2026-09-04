// The app handler the dev server wraps: instrumentation + config rules + the default
// cache store booted once, then `createApp` wired to the per-generation dev state, and the
// Live Server Components hub on top.

import { join } from "@std/path";
import { createApp, type RequestHandler } from "../../server/app.ts";
import { getPluginRequestHandler } from "../../plugin/mod.ts";
import { resolveDefaultCacheStore } from "../../server/cache.ts";
import { installLiveHub } from "../../server/live.ts";
import {
  type HeaderRule,
  type RedirectRule,
  resolveConfigRules,
  resolveLive,
  resolveStreaming,
  type RewriteRule,
} from "../../server/config.ts";
import {
  loadInstrumentation,
  runRegister,
  setNextRuntimeEnv,
} from "../../server/instrumentation.ts";
import { clientEntryFor, getMiddleware, styleHrefsFor } from "./bundles.ts";
import { devOriginAllowed } from "./dev-endpoints.ts";
import { getManifest } from "./manifest.ts";
import { broadcastError } from "./reload.ts";
import { DEV_RELOAD_JS_PATH, type DevState } from "./state.ts";

/**
 * Config redirect/rewrite/header rules, resolved once (async; createApp compiles them
 * lazily on first request, by which time these arrays are populated).
 */
function startConfigRules(st: DevState) {
  const redirects: RedirectRule[] = [];
  const rewrites: RewriteRule[] = [];
  const headers: HeaderRule[] = [];
  void (async () => {
    const r = await resolveConfigRules(st.paths.config);
    redirects.push(...r.redirects);
    rewrites.push(...r.rewrites);
    headers.push(...r.headers);
  })();
  return { redirects, rewrites, headers };
}

/**
 * Instrumentation: load + run register() once at boot (async; requests arrive after).
 * `onRequestError` forwards through the state holder so it's live once loaded.
 */
function startInstrumentation(st: DevState): void {
  setNextRuntimeEnv();
  void (async () => {
    st.instrumentation = await loadInstrumentation(st.paths.instrumentationPath);
    await runRegister(st.instrumentation);
  })();
}

/**
 * Install the durable default cache store (node:sqlite) unless the app set one itself;
 * the db lives in THIS project's .denext (not the launcher's cwd). Fails safe to in-memory.
 */
function installDefaultCacheStore(st: DevState): void {
  const cache = st.paths.config?.cache;
  void resolveDefaultCacheStore(
    cache?.path ? cache : { ...cache, path: join(st.paths.outDir, "cache.db") },
  );
}

/**
 * Surface server-side render errors in the browser overlay (dev), not only the terminal —
 * the persistent SSE connection shows it on the loaded page. Client-aborted requests
 * (nav-away / cancelled fetch) are skipped: not a code bug, and broadcasting them would
 * spam the overlay.
 */
function onRequestError(
  st: DevState,
): NonNullable<Parameters<typeof createApp>[0]["onRequestError"]> {
  return (error, request, context) => {
    const aborted = error instanceof Error &&
      (error.name === "AbortError" || /aborted/i.test(error.message));
    if (!aborted) broadcastError(st, "Server render error", error);
    return st.instrumentation.onRequestError?.(error, request, context);
  };
}

/** The createApp handler for this dev server, plus the Live hub over it. */
export function createDevApp(st: DevState): RequestHandler {
  const { paths } = st;
  startInstrumentation(st);
  const rules = startConfigRules(st);
  installDefaultCacheStore(st);
  const appHandler = createApp({
    getManifest: () => getManifest(st),
    load: st.load,
    publicDir: paths.publicDir,
    clientEntryFor: (route) => clientEntryFor(st, route),
    styleHrefsFor: (route) => styleHrefsFor(st, route),
    getMiddleware: () => getMiddleware(st),
    // Plugins register lazily on the first getManifest (after createApp), so resolve the
    // combined handler per request. Only wired when plugins exist.
    matchExternal: paths.config?.plugins?.length
      ? async (request: Request) => {
        const handler = getPluginRequestHandler();
        return handler ? await handler(request) : null;
      }
      : undefined,
    onRequestError: onRequestError(st),
    devScriptSrc: DEV_RELOAD_JS_PATH,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: rules.redirects,
    rewrites: rules.rewrites,
    headerRules: rules.headers,
    flight: true,
    appDir: paths.appDir,
    flightRoutes: st.flightRoutes,
    flightClients: st.flightClients,
    flightServers: st.flightServers,
    cacheComponents: paths.config?.experimental?.cacheComponents,
    csp: paths.config?.csp,
    streaming: resolveStreaming(paths.config),
    hsts: paths.config?.hsts,
  });
  // Live Server Components hub (dev): push `<Live>` boundary updates over a WebSocket.
  // Same-origin gate reuses the dev-origin allowlist used for SSE.
  installLiveHub({
    appHandler,
    originAllowed: (req) => devOriginAllowed(req, new URL(req.url), st.allowedDevOrigins),
    config: resolveLive(paths.config),
  });
  return appHandler;
}
