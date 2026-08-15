// Development server: SSR + on-demand client bundling + live reload.

import { join, toFileUrl } from "@std/path";
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
import { createUseCacheLoader } from "./use-cache-loader.ts";
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
  routeEntryFiles,
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
/**
 * Inline dev script injected into every dev page: live reload / Fast Refresh over
 * SSE, the `__denextDev` marker, and the dev error overlay (runtime errors,
 * unhandled rejections, and server-pushed build errors). Exported for tests;
 * never emitted into a production build.
 */
export const DEV_RELOAD_SCRIPT = `
(function () {
  window.__denextDev = true;
  // --- Dev error overlay -----------------------------------------------------
  var overlay = null;
  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
  function showOverlay(title, message, stack) {
    hideOverlay();
    overlay = document.createElement("div");
    overlay.setAttribute("style",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(20,10,10,.96);" +
      "color:#e6e6e6;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "padding:24px 28px;overflow:auto;");
    var h = document.createElement("div");
    h.setAttribute("style", "color:#ff6b6b;font-weight:700;font-size:15px;margin-bottom:6px;");
    h.textContent = "denext — " + title;
    var m = document.createElement("div");
    m.setAttribute("style", "color:#ffd7d7;white-space:pre-wrap;margin-bottom:14px;font-size:14px;");
    m.textContent = message || "";
    var s = document.createElement("pre");
    s.setAttribute("style", "white-space:pre-wrap;color:#b9b9b9;margin:0;");
    s.textContent = stack || "";
    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("style",
      "position:absolute;top:14px;right:18px;background:none;border:none;color:#999;" +
      "font-size:26px;cursor:pointer;line-height:1;");
    close.onclick = hideOverlay;
    overlay.appendChild(close);
    overlay.appendChild(h);
    overlay.appendChild(m);
    overlay.appendChild(s);
    (document.body || document.documentElement).appendChild(overlay);
  }
  window.__denextOverlay = showOverlay;
  window.addEventListener("error", function (e) {
    if (e && e.error) showOverlay("Runtime error", e.error.message, e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (r) showOverlay("Unhandled rejection", r.message || String(r), r.stack);
  });

  function refresh() {
    // Fast Refresh: re-import the route entry (cache-busted) so it re-runs
    // startClient -> retainedRoot.render(), reconciling edits in place and
    // preserving hook state. The entry falls back to a full reload if the
    // refresh is unsafe (hook-shape change) or hydration throws.
    try {
      var s = document.querySelector('script[type=module][src*="/_denext/"]');
      if (!s) { location.reload(); return; }
      var u = new URL(s.getAttribute("src"), location.href);
      // Defense-in-depth: the [src*="/_denext/"] selector matches on a substring,
      // so a cross-origin script (e.g. https://evil.example/_denext/x.js) could be
      // picked up. Only ever re-import from our own origin; otherwise hard-reload.
      if (u.origin !== location.origin) { location.reload(); return; }
      u.searchParams.set("hmr", String((window.__denextHmr = (window.__denextHmr || 0) + 1)));
      window.__denextRefreshing = true;
      var n = document.createElement("script");
      n.type = "module";
      n.src = u.href;
      n.onload = function () { n.remove(); };
      n.onerror = function () { n.remove(); location.reload(); };
      document.body.appendChild(n);
    } catch (_) { location.reload(); }
  }
  try {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.onmessage = function (e) {
      if (e.data === "refresh") { hideOverlay(); refresh(); }
      else if (e.data === "reload") location.reload();
      else if (e.data.indexOf("error:") === 0) {
        try {
          var p = JSON.parse(e.data.slice(6));
          showOverlay(p.title || "Build error", p.message, p.stack);
        } catch (_) {}
      }
    };
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
  /**
   * Extra origins (or bare hostnames) permitted to open the dev live-reload
   * stream, beyond the dev server's own origin. Mirrors Next.js's
   * `allowedDevOrigins` — needed when reaching the dev server from another host
   * (a LAN device, a proxy). A cross-origin page not listed here is refused, so a
   * malicious site a developer visits cannot subscribe to the reload channel.
   */
  allowedDevOrigins?: string[];
}

/**
 * Is `request` allowed to reach a dev-only endpoint? A missing `Origin` (a
 * non-browser client) is allowed; a browser `Origin` must match the server's own
 * host or an entry in `allowed`. Defeats a cross-origin page subscribing to the
 * dev reload/HMR channel (cf. CVE-2025-48068).
 */
export function devOriginAllowed(request: Request, url: URL, allowed: string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / tests — no cross-origin browser risk
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // malformed Origin
  }
  if (host === url.host) return true; // same-origin
  const hostname = host.split(":")[0];
  return allowed.some((a) => a === origin || a === host || a === hostname);
}

export function startDevServer(options: DevServerOptions): Deno.HttpServer {
  const { paths, allowedDevOrigins = [] } = options;

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
      const bm = await buildBoundaryManifest(paths.appDir, [
        ...new Set(m.pages.flatMap(routeEntryFiles)),
      ], {
        exportsOf: importFunctionExports,
      });
      for (const [id, ref] of bm.client) flightClients.set(id, ref);
      for (const [id, ref] of bm.server) flightServers.set(id, ref);
    }
    flightBundle = null;
    boundaryGen = generation;
  }

  // Dev module loader: cache-bust via the generation query so edits reload.
  const baseLoad: ModuleLoader = (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(`${href}?g=${generation}`);
  };
  // Cache Components (experimental): wrap the loader so `"use cache"` directives
  // compile into server-side caching. The wrapper — and the transformed copies it
  // writes — is rebuilt per generation so edits are picked up on reload.
  const useCacheEnabled = paths.config?.experimental?.cacheComponents ?? false;
  let ucLoad: ModuleLoader | null = null;
  let ucLoadGen = -1;
  const load: ModuleLoader = (filePath) => {
    if (!useCacheEnabled) return baseLoad(filePath);
    if (ucLoadGen !== generation) {
      ucLoad = createUseCacheLoader(baseLoad, {
        projectDir: paths.projectDir,
        cacheDir: join(paths.outDir, "server-cache", String(generation)),
      });
      ucLoadGen = generation;
    }
    return ucLoad!(filePath);
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
  //
  // BLD-M3 — dev/prod bundling divergence (documented, intentional): the dev
  // server bundles each route INDEPENDENTLY and lazily (for fast incremental
  // rebuilds), so the client runtime is inlined per route rather than hoisted into
  // one shared chunk the way the production build's single code-split pass does
  // (see `bundleRoutes` in build.ts). A production page therefore shares exactly
  // one runtime module instance across route entries; in dev, two route entries
  // loaded into the same document would each carry their own copy. denext only
  // ever loads one route entry per page, so this is latent — but the PRODUCTION
  // build is the source of truth for runtime-singleton behavior. Always verify a
  // release against `denext build` output, not just the dev server.
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
        dev: true, // emit Fast Refresh registration into the entry
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
    const boundary = await buildBoundaryManifest(paths.appDir, [
      ...new Set(m.pages.flatMap(routeEntryFiles)),
    ], {
      exportsOf: importFunctionExports,
    });
    const bundle = await bundleFlightEntry(boundary, {
      configPath: paths.configPath,
      importMap: await bundleImportMap(),
      dev: true, // emit Fast Refresh registration for client islands
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
    cacheComponents: paths.config?.experimental?.cacheComponents,
  });

  // Live-reload subscribers.
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  /**
   * Notify subscribers of a change. `kind` is "refresh" for a Fast Refresh
   * attempt (source-only edits — the client re-imports the route entry, keeping
   * state) or "reload" for a full reload (CSS/assets/config, or anything the
   * refresh can't handle). The client falls back to a full reload on its own if a
   * refresh turns out to be unsafe.
   */
  function broadcast(kind: "refresh" | "reload"): void {
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: ${kind}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  /**
   * Push a build/bundle error to subscribers as an `error:<json>` frame so the
   * dev error overlay shows it. The JSON has no literal newlines (they are escaped
   * within the string), so it rides in a single SSE `data:` line.
   */
  function broadcastError(title: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    const payload = JSON.stringify({ title, message, stack });
    for (const controller of reloadClients) {
      try {
        controller.enqueue(encoder.encode(`data: error:${payload}\n\n`));
      } catch {
        reloadClients.delete(controller);
      }
    }
  }

  /**
   * Whether a change set can be handled by Fast Refresh (re-import the route
   * entry, preserving state) rather than a full reload. Only JSX component
   * modules qualify: `.css`/assets need a stylesheet refetch, and `.ts`
   * server/config/middleware edits need the server to re-render. Empty → reload.
   */
  function refreshable(changedPaths: string[]): boolean {
    if (changedPaths.length === 0) return false;
    return changedPaths.every((p) => {
      if (!/\.(tsx|jsx)$/.test(p)) return false;
      if (paths.middlewarePath && p === paths.middlewarePath) return false;
      if (paths.publicDir && p.startsWith(paths.publicDir)) return false;
      return true;
    });
  }

  // Watch app + public dirs and invalidate on change. Close cleanly on shutdown
  // so the watcher and live-reload streams don't outlive the server.
  watch();
  async function watch(): Promise<void> {
    const candidates = [paths.appDir, paths.publicDir];
    if (paths.middlewarePath) candidates.push(paths.middlewarePath);
    // Deno.watchFs throws NotFound if any path is missing; an app need not have a
    // `public/` dir (or middleware), so only watch what actually exists.
    const watched = candidates.filter((p) => {
      try {
        Deno.statSync(p);
        return true;
      } catch {
        return false;
      }
    });
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
    // Accumulate the paths changed during a debounce window so we can choose Fast
    // Refresh (source-only) vs a full reload (CSS/assets/config/middleware).
    let changed: string[] = [];
    try {
      for await (const event of watcher) {
        for (const p of event.paths) changed.push(p);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const paths = changed;
          changed = [];
          generation++;
          manifest = null;
          bundleCache.clear();
          chunkCache.clear();
          broadcast(refreshable(paths) ? "refresh" : "reload");
        }, 60);
      }
    } catch { /* watcher closed on shutdown */ }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Live-reload SSE stream. Refuse a cross-origin subscriber (defense-in-depth
    // against a malicious page reading dev signals — cf. CVE-2025-48068).
    if (url.pathname === RELOAD_PATH) {
      if (!devOriginAllowed(request, url, allowedDevOrigins)) {
        return new Response("forbidden", { status: 403 });
      }
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
        broadcastError("Flight bundle error", err);
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
        deviceSizes: paths.config?.images?.deviceSizes,
        imageSizes: paths.config?.images?.imageSizes,
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
        broadcastError("Bundle error", err);
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
