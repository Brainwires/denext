// denext desktop runtime: serve a denext SPA export (`out/`) inside a native
// `deno desktop` window, optionally reverse-proxying a backend (`spa.proxy`). The
// app-level `desktop.ts` that `migrate --desktop` / `create --desktop` generates is
// a thin call to {@link runDesktop} — the serve + proxy + window plumbing lives here
// so a fix reaches every app.
//
// Serving reuses denext's {@link serveStatic} (content-types, gzip negotiation,
// path-traversal protection) over the export dir, with an SPA history fallback to
// `index.html` and `no-store` caching so a repackaged app never serves a stale
// bundle from the WebView cache. The proxy is the same mechanism as `denext start`
// in `mode:"spa"` (see {@link matchesProxyPrefix}/{@link proxyToBackend}).

import { fromFileUrl, join } from "@std/path";
import type { SpaProxyConfig } from "../server/config.ts";
import { serveStatic } from "../server/static.ts";
import { wantsShell } from "./spa/shared.ts";

type ProxyModule = typeof import("./dev-proxy.ts");

export interface RunDesktopOptions {
  /**
   * Absolute path (or a path relative to {@link importMetaUrl}) of the static export
   * to serve. Default: `out/` resolved relative to `importMetaUrl`, else `<cwd>/out`.
   */
  outDir?: string;
  /**
   * Pass `import.meta.url` from the app's `desktop.ts` so `out/` resolves relative to
   * the entry module — which is how it works both under `deno desktop desktop.ts` and
   * from inside the packaged `.app` (where the CWD is not the project).
   */
  importMetaUrl?: string;
  /** Local server port. Default: env `PORT`, else `8000`. */
  port?: number;
  /**
   * Backend reverse-proxy config. Generated `desktop.ts` passes
   * `config.spa?.proxy` from the app's `denext.config.ts` (compiled into the entry,
   * since the packaged app has no config file at runtime). Omit for no proxy.
   */
  proxy?: SpaProxyConfig;
  /**
   * Escape hatch: intercept a request before the default proxy/serve. Return a
   * `Response` to handle it; return `null`/`undefined` to fall through.
   */
  onRequest?: (
    req: Request,
    url: URL,
  ) => Response | null | undefined | Promise<Response | null | undefined>;
}

// The SPA entry is stably named (`/_denext/client/index.js`), so the WebView would
// otherwise serve a cached copy after a repackage — force revalidation every load.
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The export dir: `outDir` (relative to the entry module when given), else `out/`. */
/** The static-export dir to serve: `outDir` (relative to `importMetaUrl` when given), else `out/`. */
export function resolveOutDir(options: RunDesktopOptions): string {
  const base = options.importMetaUrl ? new URL(".", options.importMetaUrl) : undefined;
  if (options.outDir) return base ? fromFileUrl(new URL(options.outDir, base)) : options.outDir;
  return base ? fromFileUrl(new URL("out", base)) : join(Deno.cwd(), "out");
}

/**
 * Closing the window (macOS red light / Cmd-W) quits the app. `Deno.serve` is a
 * permanently-live task, so deno desktop won't auto-exit on close; adopt the initial
 * window and exit on its `close`. Guarded so a non-desktop run is a no-op.
 */
function installWindowCloseHandler(): void {
  try {
    // deno-lint-ignore no-explicit-any
    const BrowserWindow = (Deno as any).BrowserWindow;
    if (typeof BrowserWindow === "function") {
      const appWindow = new BrowserWindow();
      appWindow.addEventListener("close", () => Deno.exit(0));
    }
  } catch (err) {
    console.error("desktop: window-close handler not installed", err);
  }
}

/**
 * The desktop request handler: the `onRequest` escape hatch, the backend proxy, the export's
 * static assets (`no-store`), the `index.html` shell for navigations, else 404. Exported
 * for tests; {@linkcode runDesktop} wires it to `Deno.serve`.
 */
export function createDesktopHandler(
  options: RunDesktopOptions,
  outDir: string,
  proxy: ProxyModule | undefined,
): (request: Request, url: URL) => Promise<Response> {
  const proxyCfg = options.proxy;
  const indexHtmlPath = join(outDir, "index.html");
  return async (request, url) => {
    if (options.onRequest) {
      const r = await options.onRequest(request, url);
      if (r) return r;
    }
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const asset = await serveStatic(outDir, url.pathname, accEnc);
    if (asset) return noStore(asset);
    if (wantsShell(request, url.pathname)) {
      const html = await Deno.readTextFile(indexHtmlPath).catch(() => null);
      if (html !== null) {
        return noStore(
          new Response(request.method === "HEAD" ? null : html, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }
    }
    return new Response("not found", { status: 404 });
  };
}

/**
 * Serve a denext SPA export in a `deno desktop` window. Adopts the initial
 * `Deno.BrowserWindow` and quits the process on window close; under a plain
 * `deno run` (no desktop runtime) it just starts the server.
 */
export async function runDesktop(options: RunDesktopOptions = {}): Promise<void> {
  const outDir = resolveOutDir(options);
  const port = options.port ?? Number(Deno.env.get("PORT") ?? 8000);
  // Imported lazily so proxy-less apps never pull in the proxy module (and its `npm:ws`).
  const proxy = options.proxy ? await import("./dev-proxy.ts") : undefined;
  installWindowCloseHandler();
  // A stray WebSocket/proxy rejection must never take down the server process.
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    console.error("desktop: unhandledrejection", (e as PromiseRejectionEvent).reason);
  });
  const handle = createDesktopHandler(options, outDir, proxy);
  Deno.serve({
    port,
    hostname: "127.0.0.1",
    onError: (e) => {
      console.error("desktop: handler error", e);
      return new Response("desktop error", { status: 502 });
    },
  }, (req) => handle(req, new URL(req.url)));
}
