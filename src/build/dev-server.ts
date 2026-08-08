// Development server: SSR + on-demand client bundling + live reload.

import { toFileUrl } from "@std/path";
import { createApp } from "../server/app.ts";
import { type RouteManifest, scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import type { ModuleLoader } from "../server/types.ts";
import {
  bundleFlightEntry,
  type BundleOutput,
  bundleRoute,
  entryCode,
  routeSourceFiles,
} from "./bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "./css.ts";
import { optimizeImage } from "../server/image-optimizer.ts";
import { IMAGE_ENDPOINT } from "../runtime/image.ts";
import {
  type HeaderRule,
  type RedirectRule,
  resolveConfigRules,
  type RewriteRule,
} from "../server/config.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
} from "./module-graph.ts";
import type { ProjectPaths } from "./paths.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import {
  type Instrumentation,
  loadInstrumentation,
  runRegister,
} from "../server/instrumentation.ts";

const RELOAD_PATH = "/_denext/reload";
const ROUTE_BUNDLE_PATH = "/_denext/route.js";
const FLIGHT_BUNDLE_PATH = "/_denext/flight.js";
const ROUTE_CSS_PATH = "/_denext/route.css";

/** Inline script injected into every page to enable live reload. */
const DEV_RELOAD_SCRIPT = `
(function () {
  try {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.onmessage = function (e) { if (e.data === "reload") location.reload(); };
    es.onerror = function () { /* reconnect handled by browser */ };
  } catch (_) {}
})();
`;

export interface DevServerOptions {
  paths: ProjectPaths;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Fail instead of falling back if the port is taken (explicit --port). */
  strictPort?: boolean;
}

export function startDevServer(options: DevServerOptions): Deno.HttpServer {
  const { paths } = options;

  // Generation counter: bumped on any file change to bust module + bundle caches.
  let generation = 0;
  let manifest: RouteManifest | null = null;

  // Flight boundary state, refreshed per generation. Mutable references shared
  // with createApp so gating/tagging stay live across edits.
  const flightRoutes = new Set<string>();
  const flightClients = new Map<string, { url: string }>();
  const flightServers = new Map<string, { url: string }>();
  let boundaryGen = -1;
  let flightBundle: string | null = null;

  // CSS assets, rebuilt per generation. `import()` of `.css` on the server is
  // handled by the CLI's `--config` re-exec; here we supply the client-bundle
  // import map and the per-route extracted stylesheet.
  let cssAssets: AppCss | null = null;
  let cssGen = -1;
  async function getCss(): Promise<AppCss | null> {
    if (cssGen !== generation) {
      cssAssets = await buildAppCss({
        projectDir: paths.projectDir,
        configPath: paths.configPath,
        outDir: paths.outDir,
        minify: false,
      });
      cssGen = generation;
    }
    return cssAssets;
  }

  async function getManifest(): Promise<RouteManifest> {
    if (!manifest) manifest = await scanRoutes(paths.appDir);
    await refreshBoundary(manifest);
    await getCss(); // ensure cssAssets is current before styleHrefsFor is read
    return manifest;
  }

  async function refreshBoundary(m: RouteManifest): Promise<void> {
    if (boundaryGen === generation) return;
    const routes = await computeBoundaryRoutes(paths.appDir, m.pages);
    flightRoutes.clear();
    for (const r of routes) flightRoutes.add(r);
    flightClients.clear();
    flightServers.clear();
    if (routes.size > 0) {
      const bm = await buildBoundaryManifest(paths.appDir, m.pages.map((p) => p.filePath), {
        exportsOf: importFunctionExports,
      });
      for (const [id, ref] of bm.client) flightClients.set(id, ref);
      for (const [id, ref] of bm.server) flightServers.set(id, ref);
    }
    flightBundle = null;
    boundaryGen = generation;
  }

  // Dev module loader: cache-bust via the generation query so edits reload.
  const load: ModuleLoader = (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(`${href}?g=${generation}`);
  };

  // Client bundle cache keyed by route path (cleared on change). Entry code
  // only; split chunks (from dynamic imports) live in `chunkCache`, served next
  // to the entry so its relative `./chunk-*.js` imports resolve.
  const bundleCache = new Map<string, string>();
  const chunkCache = new Map<string, string>();

  // Stash a bundle's split chunks (everything but the entry) for serving.
  function cacheChunks(bundle: BundleOutput): void {
    for (const [name, code] of bundle.files) {
      if (name !== bundle.entry) chunkCache.set(name, code);
    }
  }

  async function getRouteBundle(route: PageRoute): Promise<string> {
    const cached = bundleCache.get(route.routePath);
    if (cached) return cached;
    const css = await getCss();
    const bundle = await bundleRoute(route, {
      configPath: paths.configPath,
      importMap: css?.importMap,
    });
    cacheChunks(bundle);
    const js = entryCode(bundle);
    bundleCache.set(route.routePath, js);
    return js;
  }

  // Flight (RSC): bundle one app-wide entry containing only the `"use client"`
  // modules; boundary routes hydrate from it instead of the whole-tree bundle.
  async function getFlightBundle(): Promise<string> {
    const m = await getManifest();
    await refreshBoundary(m);
    if (flightBundle) return flightBundle;
    const boundary = await buildBoundaryManifest(paths.appDir, m.pages.map((p) => p.filePath), {
      exportsOf: importFunctionExports,
    });
    const css = await getCss();
    const bundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      importMap: css?.importMap,
    });
    cacheChunks(bundle);
    flightBundle = entryCode(bundle);
    return flightBundle;
  }

  const clientEntryFor = (route: PageRoute): string =>
    flightRoutes.has(route.routePath)
      ? FLIGHT_BUNDLE_PATH
      : `${ROUTE_BUNDLE_PATH}?p=${encodeURIComponent(route.routePath)}`;

  // Link a per-route stylesheet only when the project has CSS at all; the CSS
  // handler serves the route's extracted subset (possibly empty).
  const styleHrefsFor = (route: PageRoute): string[] | undefined =>
    cssAssets ? [`${ROUTE_CSS_PATH}?p=${encodeURIComponent(route.routePath)}`] : undefined;

  // Middleware runner, rebuilt whenever the generation changes.
  let middlewareRunner: MiddlewareRunner = null;
  let middlewareGen = -1;
  async function getMiddleware(): Promise<MiddlewareRunner> {
    if (!paths.middlewarePath) return null;
    if (middlewareGen !== generation) {
      const mod = await load(paths.middlewarePath);
      middlewareRunner = createMiddlewareRunner(mod as never);
      middlewareGen = generation;
    }
    return middlewareRunner;
  }

  // Instrumentation: load + run register() once at boot (async; requests arrive
  // after). onRequestError forwards through the holder so it's live once loaded.
  let instrumentation: Instrumentation = {};
  (async () => {
    instrumentation = await loadInstrumentation(paths.instrumentationPath);
    await runRegister(instrumentation);
  })();

  // Config redirect/rewrite/header rules, resolved once (async; createApp compiles
  // them lazily on first request, by which time these arrays are populated).
  const configRedirects: RedirectRule[] = [];
  const configRewrites: RewriteRule[] = [];
  const configHeaders: HeaderRule[] = [];
  (async () => {
    const r = await resolveConfigRules(paths.config);
    configRedirects.push(...r.redirects);
    configRewrites.push(...r.rewrites);
    configHeaders.push(...r.headers);
  })();

  const appHandler = createApp({
    getManifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor,
    styleHrefsFor,
    getMiddleware,
    onRequestError: (error, request, context) =>
      instrumentation.onRequestError?.(error, request, context),
    devScript: DEV_RELOAD_SCRIPT,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: configRedirects,
    rewrites: configRewrites,
    headerRules: configHeaders,
    flight: true,
    appDir: paths.appDir,
    flightRoutes,
    flightClients,
    flightServers,
  });

  // Live-reload subscribers.
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  function broadcastReload(): void {
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode("data: reload\n\n"));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  // Watch app + public dirs and invalidate on change.
  watch();
  async function watch(): Promise<void> {
    const watched = [paths.appDir, paths.publicDir];
    if (paths.middlewarePath) watched.push(paths.middlewarePath);
    const watcher = Deno.watchFs(watched, { recursive: true });
    let debounce: ReturnType<typeof setTimeout> | undefined;
    for await (const _event of watcher) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        generation++;
        manifest = null;
        bundleCache.clear();
        chunkCache.clear();
        broadcastReload();
      }, 60);
    }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Live-reload SSE stream.
    if (url.pathname === RELOAD_PATH) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          reloadClients.add(controller);
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
        },
        cancel() {/* controller removed lazily on next broadcast */},
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // App-wide Flight bundle (client islands + registry).
    if (url.pathname === FLIGHT_BUNDLE_PATH) {
      try {
        const js = await getFlightBundle();
        return new Response(js, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        console.error("denext: flight bundle error", err);
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          `console.error(${JSON.stringify("denext flight bundle error:\n" + msg)});`,
          { status: 500, headers: { "content-type": "text/javascript" } },
        );
      }
    }

    // Built-in image optimization endpoint.
    if (url.pathname === IMAGE_ENDPOINT) {
      return optimizeImage(request, { publicDir: paths.publicDir });
    }

    // Per-route extracted stylesheet (transformed CSS the route's graph reaches).
    if (url.pathname === ROUTE_CSS_PATH) {
      const routePath = url.searchParams.get("p");
      const m = await getManifest();
      const route = m.pages.find((p) => p.routePath === routePath);
      const css = await getCss();
      const text = route && css ? await extractRouteCss(routeSourceFiles(route), css) : "";
      return new Response(text, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Split chunk from a dynamic import, emitted next to a route/flight entry.
    // The entry's relative `./chunk-*.js` import resolves here; the entry request
    // populated `chunkCache` before returning, so the chunk is present by now.
    if (url.pathname.startsWith("/_denext/") && url.pathname.endsWith(".js")) {
      const chunk = chunkCache.get(url.pathname.slice("/_denext/".length));
      if (chunk !== undefined) {
        return new Response(chunk, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    }

    // On-demand client route bundle.
    if (url.pathname === ROUTE_BUNDLE_PATH) {
      const routePath = url.searchParams.get("p");
      const m = await getManifest();
      const route = m.pages.find((p) => p.routePath === routePath);
      if (!route) return new Response("// route not found", { status: 404 });
      try {
        const js = await getRouteBundle(route);
        return new Response(js, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        console.error("denext: bundle error", err);
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          `console.error(${JSON.stringify("denext bundle error:\n" + msg)});`,
          { status: 500, headers: { "content-type": "text/javascript" } },
        );
      }
    }

    return appHandler(request);
  }

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "localhost",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) =>
          console.log(
            `\n  denext dev  ▸  http://${hostname}:${port}\n` +
              `  watching ${paths.appDir}\n`,
          )),
    },
    handler,
  );
}
