// The denext application request handler: routes a Request to an API handler,
// a rendered page, a static file, or a 404.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderGlobalError, renderPage, renderRootNotFound } from "./render-page.ts";
import { isRedirect } from "../runtime/error-boundary.ts";
import { createRequestContext, runWithContext } from "./request-context.ts";
import { type HydrationData, renderDocument } from "./document.ts";
import { serveStatic } from "./static.ts";
import type { ModuleLoader } from "./types.ts";
import { type MiddlewareRunner, withHeaders } from "./middleware.ts";
import { type I18nConfig, peelLocale } from "./i18n.ts";
import { type PageCache, pageCacheExpiry } from "./cache.ts";
import { handleAction, isActionRequest } from "./action-handler.ts";
import { serveMetadataFile } from "./metadata-files.ts";

/** Configuration for {@linkcode createApp}: how to resolve routes, load modules, and render. */
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
  /** Optional i18n config enabling optional-prefix locale routing. */
  i18n?: I18nConfig;
  /** Optional rendered-page cache enabling ISR (typically the prod server). */
  pageCache?: PageCache;
  /**
   * Extra origins allowed to invoke Server Actions, beyond the request's own
   * Host (for reverse-proxy / multi-host deployments). Actions are same-origin
   * only by default.
   */
  allowedOrigins?: string[];
}

/** An HTTP request handler that resolves a {@linkcode Request} to a {@linkcode Response}. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Build a request handler from app configuration. */
export function createApp(config: AppConfig): RequestHandler {
  return function handle(originalRequest: Request): Promise<Response> {
    // Establish the per-request async context so cookies()/headers() work in
    // server components, route handlers, and middleware.
    const requestCtx = createRequestContext(originalRequest);
    return runWithContext(requestCtx, async (): Promise<Response> => {
      let request = originalRequest;
      let url = new URL(request.url);
      let pathname = url.pathname;
      let injectedHeaders: Headers | undefined;

      try {
        // Root middleware runs before routing.
        const runner = config.getMiddleware ? await config.getMiddleware() : null;
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

        const finalize = (r: Response): Response => {
          let res = injectedHeaders ? withHeaders(r, injectedHeaders) : r;
          // Apply any Set-Cookie headers queued via cookies().set()/delete().
          const setCookies = requestCtx.outgoingHeaders.getSetCookie();
          if (setCookies.length > 0) {
            const headers = new Headers(res.headers);
            for (const c of setCookies) headers.append("set-cookie", c);
            res = new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
          }
          return res;
        };

        // Server Actions: dispatch POSTs to the reserved action endpoint before
        // routing. Same-origin enforced inside handleAction (CSRF defense).
        if (isActionRequest(request, pathname)) {
          return finalize(await handleAction(request, { allowedOrigins: config.allowedOrigins }));
        }

        const manifest = await config.getManifest();

        // Metadata files (sitemap.xml / robots.txt / manifest.webmanifest / favicon).
        if (request.method === "GET" || request.method === "HEAD") {
          const metaFile = await serveMetadataFile(manifest, pathname, config.load);
          if (metaFile) return finalize(metaFile);
        }

        // Peel an optional locale prefix off the path (i18n). Matching runs
        // against the stripped path; the locale is merged into route params.
        const localeInfo = config.i18n ? peelLocale(pathname, config.i18n) : null;
        const routingPath = localeInfo ? localeInfo.rest : pathname;

        // 1. API routes.
        const api = matchApi(manifest, routingPath);
        if (api) return finalize(await handleApi(api, request, config.load));

        // 2. Pages (GET/HEAD only).
        if (request.method === "GET" || request.method === "HEAD") {
          // Soft (client) navigations carry x-denext-nav; enables interception.
          const soft = request.headers.get("x-denext-nav") === "1";
          const matched = matchPage(manifest, routingPath, { soft });
          const page = matched && localeInfo
            ? {
              route: matched.route,
              params: { ...matched.params, locale: localeInfo.locale },
            }
            : matched;
          if (page) {
            // ISR: serve a fresh cached render when available (impersonal GETs).
            const cacheable = config.pageCache && !soft && request.method === "GET";
            const cacheKey = pathname + url.search;
            if (cacheable) {
              const hit = config.pageCache!.get(cacheKey);
              if (hit) {
                return new Response(hit.body, {
                  status: hit.status,
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "x-denext-cache": "HIT",
                  },
                });
              }
            }

            let rendered;
            try {
              rendered = await renderPage(page, request, config.load);
            } catch (pageError) {
              // redirect() from a server component issues an HTTP redirect.
              if (isRedirect(pageError)) {
                return finalize(
                  new Response(null, {
                    status: pageError.status,
                    headers: { location: pageError.url },
                  }),
                );
              }
              // A global-error.tsx replaces the whole tree on an uncaught error.
              const ge = await renderGlobalError(manifest, config.load, pageError);
              if (!ge) throw pageError;
              rendered = ge;
            }
            const { html, metadata, status } = rendered;

            // ISR: cache the rendered document when the config opts in.
            if (cacheable && status === 200) {
              const expiresAt = pageCacheExpiry(rendered.config);
              if (expiresAt !== null) {
                // Build the document once here so the cached body matches.
                const cachedDoc = renderDocument({
                  bodyHtml: html,
                  metadata,
                  hydration: config.clientEntryFor?.(page.route)
                    ? {
                      params: page.params,
                      searchParams: url.searchParams.toString(),
                      pathname,
                    }
                    : undefined,
                  clientEntry: config.clientEntryFor?.(page.route),
                  devScript: config.devScript,
                });
                config.pageCache!.set(cacheKey, {
                  body: cachedDoc,
                  status,
                  path: pathname,
                  expiresAt,
                  tags: [],
                });
                return finalize(
                  new Response(cachedDoc, {
                    status,
                    headers: {
                      "content-type": "text/html; charset=utf-8",
                      "x-denext-cache": "MISS",
                    },
                  }),
                );
              }
            }

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

        // 4. Not found — render the app's root not-found UI for page requests.
        if (request.method === "GET" || request.method === "HEAD") {
          const { html, metadata, status } = await renderRootNotFound(
            manifest,
            config.load,
          );
          const doc = renderDocument({
            bodyHtml: html,
            metadata,
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
        return finalize(notFound(pathname));
      } catch (error) {
        if (config.onError) return await config.onError(error, request);
        console.error("denext: unhandled error while handling", pathname, error);
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    });
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
