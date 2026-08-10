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
import { tailwindPaths } from "./tailwind.ts";
import { collectComponentSources, compileModules } from "./compiler.ts";
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

/**
 * Inline script injected into every dev page. It enables live reload and marks
 * the page as a dev build (`__denextDev`) so the client reconciler can emit
 * hydration-mismatch warnings — production pages never carry this script. It is
 * a plain (non-module) script placed before `</body>`, so it runs during parse,
 * ahead of the deferred hydration module.
 */
const DEV_RELOAD_SCRIPT = `
(function () {
  window.__denextDev = true;
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

  // Mark this (dev) process as a dev build so server-side render passes emit the
  // same developer warnings the browser bundle does (dangerouslySetInnerHTML,
  // dangerous URL schemes). Production `start` never runs this module, so it stays
  // off there. Mirrors the `window.__denextDev = true` set in the client script.
  (globalThis as { __denextDev?: boolean }).__denextDev = true;

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
        tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
      });
      cssGen = generation;
    }
    return cssAssets;
  }

  // Auto-memo compiler (experimental, opt-in): a map of original → transformed
  // module URLs, merged into the client bundle's import-map redirects. Rebuilt per
  // generation so edits are picked up on reload.
  let compilerMap: Record<string, string> = {};
  let compilerGen = -1;
  async function getCompilerMap(): Promise<Record<string, string>> {
    if (!paths.config?.experimental?.compiler) return {};
    if (compilerGen !== generation) {
      const sources = await collectComponentSources(paths.projectDir);
      compilerMap = await compileModules(sources, { outDir: paths.outDir });
      compilerGen = generation;
    }
    return compilerMap;
  }

  /** The merged client-bundle import map (CSS redirects + compiler redirects). */
  async function bundleImportMap(): Promise<Record<string, string> | undefined> {
    const css = await getCss();
    const merged = { ...css?.importMap, ...await getCompilerMap() };
    return Object.keys(merged).length > 0 ? merged : undefined;
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

  // Coalesce concurrent first-hits for the same route so a burst of requests
  // doesn't spawn duplicate `deno bundle` subprocesses.
  const routeInFlight = new Map<string, Promise<string>>();
  async function getRouteBundle(route: PageRoute): Promise<string> {
    const cached = bundleCache.get(route.routePath);
    if (cached) return cached;
    const pending = routeInFlight.get(route.routePath);
    if (pending) return pending;
    const build = (async () => {
      const bundle = await bundleRoute(route, {
        configPath: paths.configPath,
        importMap: await bundleImportMap(),
      });
      cacheChunks(bundle);
      const js = entryCode(bundle);
      bundleCache.set(route.routePath, js);
      return js;
    })();
    routeInFlight.set(route.routePath, build);
    try {
      return await build;
    } finally {
      routeInFlight.delete(route.routePath);
    }
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
    const bundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      importMap: await bundleImportMap(),
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

  // Watch app + public dirs and invalidate on change. Close cleanly on shutdown
  // so the watcher and live-reload streams don't outlive the server.
  watch();
  async function watch(): Promise<void> {
    const watched = [paths.appDir, paths.publicDir];
    if (paths.middlewarePath) watched.push(paths.middlewarePath);
    const watcher = Deno.watchFs(watched, { recursive: true });
    options.signal?.addEventListener("abort", () => {
      try {
        watcher.close();
      } catch { /* already closed */ }
      for (const controller of reloadClients) {
        try {
          controller.close();
        } catch { /* already closed */ }
      }
      reloadClients.clear();
    });
    let debounce: ReturnType<typeof setTimeout> | undefined;
    try {
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
    } catch { /* watcher closed on shutdown */ }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Live-reload SSE stream.
    if (url.pathname === RELOAD_PATH) {
      let ref: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ref = controller;
          reloadClients.add(controller);
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
        },
        cancel(): void {
          if (ref) reloadClients.delete(ref);
        },
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

    // Liveness/readiness probe endpoint (for load balancers / k8s).
    if (url.pathname === "/_denext/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }
    // Built-in image optimization endpoint.
    if (url.pathname === IMAGE_ENDPOINT) {
      return optimizeImage(request, {
        publicDir: paths.publicDir,
        allowedHosts: paths.config?.images?.domains,
        remotePatterns: paths.config?.images?.remotePatterns,
      });
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
