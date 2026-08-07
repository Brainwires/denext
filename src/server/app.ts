// The denext application request handler: routes a Request to an API handler,
// a rendered page, a static file, or a 404.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderPage } from "./render-page.ts";
import {
  type HydrationData,
  renderDocument,
} from "./document.ts";
import { serveStatic } from "./static.ts";
import type { ModuleLoader } from "./types.ts";
import { type MiddlewareRunner, withHeaders } from "./middleware.ts";

export interface AppConfig {
  /** Resolve the current route manifest (re-scanned per request in dev). */
  getManifest: () => RouteManifest | Promise<RouteManifest>;
  /** Load a route/layout/api module by file path. */
  load: ModuleLoader;
  /** Directory of static assets served at the URL root. */
  publicDir?: string;
  /** Per-route browser bundle URL; when it returns a URL, hydration is enabled. */
  clientEntryFor?: (route: PageRoute) => string | undefined;
  /** Inline script injected before </body> (dev live-reload, etc.). */
  devScript?: string;
  /** Optional root middleware runner (from middleware.ts / proxy.ts). */
  getMiddleware?: () =>
    | MiddlewareRunner
    | Promise<MiddlewareRunner>;
  /** Custom error renderer; defaults to a plain 500. */
  onError?: (error: unknown, request: Request) => Response | Promise<Response>;
}

export type RequestHandler = (request: Request) => Promise<Response>;

/** Build a request handler from app configuration. */
export function createApp(config: AppConfig): RequestHandler {
  return async function handle(originalRequest: Request): Promise<Response> {
    let request = originalRequest;
    let url = new URL(request.url);
    let pathname = url.pathname;
    let injectedHeaders: Headers | undefined;

    try {
      // Root middleware runs before routing.
      const runner = config.getMiddleware
        ? await config.getMiddleware()
        : null;
      if (runner) {
        const outcome = await runner(request);
        if (outcome.type === "response") return outcome.response;
        if (outcome.type === "rewrite") {
          // Route as if the request were for the rewritten URL.
          request = new Request(outcome.url, request);
          url = new URL(request.url);
          pathname = url.pathname;
          injectedHeaders = outcome.headers;
        } else if (outcome.headers) {
          injectedHeaders = outcome.headers;
        }
      }

      const finalize = (r: Response): Response =>
        injectedHeaders ? withHeaders(r, injectedHeaders) : r;

      const manifest = await config.getManifest();

      // 1. API routes.
      const api = matchApi(manifest, pathname);
      if (api) return finalize(await handleApi(api, request, config.load));

      // 2. Pages (GET/HEAD only).
      if (request.method === "GET" || request.method === "HEAD") {
        const page = matchPage(manifest, pathname);
        if (page) {
          const { html, metadata, status } = await renderPage(
            page,
            request,
            config.load,
          );

          const clientEntry = config.clientEntryFor?.(page.route);
          const hydration: HydrationData | undefined = clientEntry
            ? {
              params: page.params,
              searchParams: url.searchParams.toString(),
              pathname,
            }
            : undefined;

          const doc = renderDocument({
            bodyHtml: html,
            metadata,
            hydration,
            clientEntry,
            devScript: config.devScript,
          });

          if (request.method === "HEAD") {
            return finalize(
              new Response(null, {
                status,
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
            );
          }
          return finalize(
            new Response(doc, {
              status,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          );
        }
      }

      // 3. Static assets.
      if (
        config.publicDir &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const asset = await serveStatic(config.publicDir, pathname);
        if (asset) return finalize(asset);
      }

      // 4. Not found.
      return finalize(notFound(pathname));
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
