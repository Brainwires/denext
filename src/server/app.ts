// The denext application request handler: routes a Request to an API handler,
// a rendered page, a static file, or a 404.

import type { RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderPage } from "./render-page.ts";
import {
  type HydrationData,
  renderDocument,
} from "./document.ts";
import { serveStatic } from "./static.ts";
import type { ModuleLoader } from "./types.ts";

export interface AppConfig {
  /** Resolve the current route manifest (re-scanned per request in dev). */
  getManifest: () => RouteManifest | Promise<RouteManifest>;
  /** Load a route/layout/api module by file path. */
  load: ModuleLoader;
  /** Directory of static assets served at the URL root. */
  publicDir?: string;
  /** URL of the client runtime entry script (enables hydration when set). */
  clientEntry?: string;
  /** Map a route file path to the browser-importable module URL. */
  clientModuleUrl?: (filePath: string) => string;
  /** Inline script injected before </body> (dev live-reload, etc.). */
  devScript?: string;
  /** Custom error renderer; defaults to a plain 500. */
  onError?: (error: unknown, request: Request) => Response | Promise<Response>;
}

export type RequestHandler = (request: Request) => Promise<Response>;

/** Build a request handler from app configuration. */
export function createApp(config: AppConfig): RequestHandler {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      const manifest = await config.getManifest();

      // 1. API routes.
      const api = matchApi(manifest, pathname);
      if (api) return await handleApi(api, request, config.load);

      // 2. Pages (GET/HEAD only).
      if (request.method === "GET" || request.method === "HEAD") {
        const page = matchPage(manifest, pathname);
        if (page) {
          const { html, metadata } = await renderPage(
            page,
            request,
            config.load,
          );

          let hydration: HydrationData | undefined;
          if (config.clientEntry && config.clientModuleUrl) {
            hydration = {
              routeModule: config.clientModuleUrl(page.route.filePath),
              layoutModules: page.route.layoutChain.map(config.clientModuleUrl!),
              params: page.params,
              searchParams: url.searchParams.toString(),
              pathname,
            };
          }

          const doc = renderDocument({
            bodyHtml: html,
            metadata,
            hydration,
            clientEntry: config.clientEntry,
            devScript: config.devScript,
          });

          if (request.method === "HEAD") {
            return new Response(null, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          return new Response(doc, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      }

      // 3. Static assets.
      if (
        config.publicDir &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const asset = await serveStatic(config.publicDir, pathname);
        if (asset) return asset;
      }

      // 4. Not found.
      return notFound(pathname);
    } catch (error) {
      if (config.onError) return await config.onError(error, request);
      console.error("denext: unhandled error while handling", pathname, error);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}

function notFound(pathname: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>404 — Not Found</title></head><body><h1>404 — Not Found</h1><p>No route matches <code>${
      pathname.replace(/[<>&]/g, "")
    }</code>.</p></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
