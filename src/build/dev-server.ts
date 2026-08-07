// Development server: SSR + on-demand client bundling + live reload.

import { toFileUrl } from "@std/path";
import { createApp } from "../server/app.ts";
import { type RouteManifest, scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import type { ModuleLoader } from "../server/types.ts";
import { bundleRoute } from "./bundle.ts";
import type { ProjectPaths } from "./paths.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";

const RELOAD_PATH = "/_denext/reload";
const ROUTE_BUNDLE_PATH = "/_denext/route.js";

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
}

export function startDevServer(options: DevServerOptions): Deno.HttpServer {
  const { paths } = options;

  // Generation counter: bumped on any file change to bust module + bundle caches.
  let generation = 0;
  let manifest: RouteManifest | null = null;

  async function getManifest(): Promise<RouteManifest> {
    if (!manifest) manifest = await scanRoutes(paths.appDir);
    return manifest;
  }

  // Dev module loader: cache-bust via the generation query so edits reload.
  const load: ModuleLoader = (filePath) => {
    const href = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
    return import(`${href}?g=${generation}`);
  };

  // Client bundle cache keyed by route path (cleared on change).
  const bundleCache = new Map<string, string>();

  async function getRouteBundle(route: PageRoute): Promise<string> {
    const cached = bundleCache.get(route.routePath);
    if (cached) return cached;
    const js = await bundleRoute(route, { configPath: paths.configPath });
    bundleCache.set(route.routePath, js);
    return js;
  }

  const clientEntryFor = (route: PageRoute): string =>
    `${ROUTE_BUNDLE_PATH}?p=${encodeURIComponent(route.routePath)}`;

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

  const appHandler = createApp({
    getManifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor,
    getMiddleware,
    devScript: DEV_RELOAD_SCRIPT,
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
