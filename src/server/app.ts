// The denext application request handler: routes a Request to an API handler,
// a rendered page, a static file, or a 404.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderGlobalError, renderPage, renderRootNotFound } from "./render-page.ts";
import { isRedirect } from "../runtime/error-boundary.ts";
import { createRequestContext, runDeferred, runWithContext } from "./request-context.ts";
import { type HydrationData, renderDocument } from "./document.ts";
import { serveStatic } from "./static.ts";
import type { ModuleLoader } from "./types.ts";
import { type MiddlewareRunner, redirect, withHeaders } from "./middleware.ts";
import { type I18nConfig, peelLocale, resolveMessages } from "./i18n.ts";
import {
  type CompiledPattern,
  compilePattern,
  fillDestination,
  type HeaderRule,
  matchPattern,
  type RedirectRule,
  type RewriteRule,
  safeRedirectLocation,
} from "./config.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import { type PageCache, pageCacheExpiry } from "./cache.ts";
import { handleAction, isActionRequest } from "./action-handler.ts";
import {
  APPLE_ICON_PATH,
  ICON_PATH,
  OPENGRAPH_IMAGE_PATH,
  serveMetadataFile,
  TWITTER_IMAGE_PATH,
} from "./metadata-files.ts";
import { absoluteUrl } from "./absolute-url.ts";
import { publicEnv } from "../runtime/public-env.ts";
import { setBasePath } from "../client/navigation.ts";
import type { OnRequestError } from "./instrumentation.ts";
import { tagClientExports, tagClientModules } from "../runtime/client-reference.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { clientIdFor } from "../build/module-graph.ts";
import type { Directive } from "../build/directives.ts";
import { toFileUrl } from "@std/path";

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
  /** Per-route stylesheet URLs (extracted CSS) linked in the document `<head>`. */
  styleHrefsFor?: (route: PageRoute) => string[] | undefined;
  /** Inline script injected before </body> (dev live-reload, etc.). */
  devScript?: string;
  /** Optional root middleware runner (from middleware.ts / proxy.ts). */
  getMiddleware?: () =>
    | MiddlewareRunner
    | Promise<MiddlewareRunner>;
  /** Custom error renderer; defaults to a plain 500. */
  onError?: (error: unknown, request: Request) => Response | Promise<Response>;
  /**
   * Report a server-side request error (from a project's `instrumentation.ts`
   * `onRequestError`). Called once per error, before {@link onError} renders the
   * response. Invoked defensively — a throw from it is logged, not propagated.
   */
  onRequestError?: OnRequestError;
  /** Optional i18n config enabling optional-prefix locale routing. */
  i18n?: I18nConfig;
  /** Serve the app under a sub-path (from `denext.config` `basePath`). */
  basePath?: string;
  /** Enforce a trailing slash on page URLs (from `denext.config` `trailingSlash`). */
  trailingSlash?: boolean;
  /** Declarative redirect rules (from `denext.config` `redirects()`). */
  redirects?: RedirectRule[];
  /** Declarative rewrite rules (from `denext.config` `rewrites()`). */
  rewrites?: RewriteRule[];
  /** Declarative response-header rules (from `denext.config` `headers()`). */
  headerRules?: HeaderRule[];
  /** Optional rendered-page cache enabling ISR (typically the prod server). */
  pageCache?: PageCache;
  /**
   * Extra origins allowed to invoke Server Actions, beyond the request's own
   * Host (for reverse-proxy / multi-host deployments). Actions are same-origin
   * only by default.
   */
  allowedOrigins?: string[];
  /**
   * An explicit public origin (e.g. `"https://example.com"`) used to build
   * absolute URLs (auto-populated `og:image`, canonical). Overrides request
   * headers — the most robust option when the origin is fixed.
   */
  canonicalOrigin?: string;
  /**
   * Trust `X-Forwarded-Proto`/`X-Forwarded-Host` when building absolute URLs.
   * Enable ONLY behind a trusted reverse proxy that sets those headers; otherwise
   * a client can spoof the generated origin. Ignored when {@link canonicalOrigin}
   * is set. Default false (forwarded headers are not trusted).
   */
  trustForwardedHeaders?: boolean;
  /**
   * Enable the Flight (`"use client"`/`"use server"`) boundary. When on (and
   * {@link appDir} is set), a route that involves a client module is rendered to
   * a Flight payload and hydrates from client islands only. Routes with no
   * boundary keep the isomorphic whole-tree hydration. Off by default.
   */
  flight?: boolean;
  /** The app directory, required for stable client-reference ids under {@link flight}. */
  appDir?: string;
  /**
   * Route paths that must render via Flight (a client island is reachable from
   * their import graph). Computed by the build (`computeBoundaryRoutes`). When
   * omitted, gating falls back to the route's own convention-module directives.
   */
  flightRoutes?: Set<string>;
  /**
   * The app's `"use client"` modules (client id → ref), imported and tagged once
   * so the renderer emits references for them. From the boundary manifest.
   */
  flightClients?: Map<string, { url: string }>;
  /**
   * The app's `"use server"` modules (module id → ref), imported and tagged once
   * so their exports auto-register and serialize as action references. From the
   * boundary manifest.
   */
  flightServers?: Map<string, { url: string }>;
}

/** An HTTP request handler that resolves a {@linkcode Request} to a {@linkcode Response}. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Build a request handler from app configuration. */
export function createApp(config: AppConfig): RequestHandler {
  // Compile config-driven redirect/rewrite/header patterns lazily on first use
  // (the dev server resolves rules asynchronously after createApp is called).
  const basePath = config.basePath?.replace(/\/$/, "") || "";
  // Make server-rendered <Link>s prefix basePath (client reads it from hydration).
  setBasePath(basePath);
  let compiled: {
    redirects: Array<{ pattern: CompiledPattern; rule: RedirectRule }>;
    rewrites: Array<{ pattern: CompiledPattern; rule: RewriteRule }>;
    headers: Array<{ pattern: CompiledPattern; rule: HeaderRule }>;
  } | null = null;
  const getCompiled = () => {
    if (!compiled) {
      compiled = {
        redirects: (config.redirects ?? []).map((rule) => ({
          pattern: compilePattern(rule.source),
          rule,
        })),
        rewrites: (config.rewrites ?? []).map((rule) => ({
          pattern: compilePattern(rule.source),
          rule,
        })),
        headers: (config.headerRules ?? []).map((rule) => ({
          pattern: compilePattern(rule.source),
          rule,
        })),
      };
    }
    return compiled;
  };

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
        // Config-driven URL handling (static denext.config rules), before routing.
        // Skip framework asset paths and requests for files with an extension.
        const isFrameworkPath = pathname.startsWith("/_denext");
        const isFile = /\.[^/]+$/.test(pathname);

        // trailing-slash normalization → 308 redirect to the canonical form.
        if (config.trailingSlash !== undefined && !isFrameworkPath && !isFile && pathname !== "/") {
          const hasSlash = pathname.endsWith("/");
          if (config.trailingSlash && !hasSlash) {
            return redirect(safeRedirectLocation(pathname + "/") + url.search, 308);
          }
          if (!config.trailingSlash && hasSlash) {
            return redirect(
              safeRedirectLocation(pathname.replace(/\/+$/, "")) + url.search,
              308,
            );
          }
        }

        const rules = getCompiled();

        // Redirects: first match wins (permanent → 308, else 307).
        for (const { pattern, rule } of rules.redirects) {
          const params = matchPattern(pattern, pathname);
          if (params) {
            return redirect(
              safeRedirectLocation(fillDestination(rule.destination, params)),
              rule.permanent ? 308 : 307,
            );
          }
        }

        // basePath: strip the configured prefix so routing sees the app-relative path.
        if (basePath && !isFrameworkPath) {
          if (pathname === basePath || pathname.startsWith(basePath + "/")) {
            pathname = pathname.slice(basePath.length) || "/";
            url = new URL(request.url);
            url.pathname = pathname;
            request = new Request(url.toString(), request);
          }
        }

        // Header rules: accumulate onto matching responses via `injectedHeaders`.
        for (const { pattern, rule } of rules.headers) {
          if (matchPattern(pattern, pathname)) {
            injectedHeaders = injectedHeaders ?? new Headers();
            for (const { key, value } of rule.headers) injectedHeaders.append(key, value);
          }
        }

        // Rewrites: internally route as the destination (no client redirect).
        for (const { pattern, rule } of rules.rewrites) {
          const params = matchPattern(pattern, pathname);
          if (params) {
            url = new URL(fillDestination(rule.destination, params), url.origin);
            pathname = url.pathname;
            request = new Request(url.toString(), request);
            break;
          }
        }

        // Root middleware runs before routing.
        const runner = config.getMiddleware ? await config.getMiddleware() : null;
        if (runner) {
          const outcome = await runner(request);
          if (outcome.type === "response") {
            return injectedHeaders
              ? withHeaders(outcome.response, injectedHeaders)
              : outcome.response;
          }
          if (outcome.type === "rewrite") {
            // Route as if the request were for the rewritten URL.
            request = new Request(outcome.url, request);
            url = new URL(request.url);
            pathname = url.pathname;
          }
          // Merge middleware headers on top of any config header rules.
          if (outcome.headers) {
            injectedHeaders = injectedHeaders ?? new Headers();
            for (const [k, v] of outcome.headers) injectedHeaders.append(k, v);
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
            // Active locale's message catalog for useTranslations() (i18n). Only
            // set when catalogs are configured, so non-i18n apps stay untouched.
            const locale = localeInfo?.locale ?? config.i18n?.defaultLocale ?? "";
            const messages: Messages | undefined = config.i18n?.messages
              ? resolveMessages(config.i18n, locale)
              : undefined;

            // ISR: serve a fresh cached render when available (impersonal GETs).
            const cacheable = config.pageCache && !soft && request.method === "GET";
            const cacheKey = pathname + url.search;
            if (cacheable) {
              const hit = await config.pageCache!.get(cacheKey);
              if (hit) {
                // Route through finalize so middleware headers (e.g. CSP) apply.
                return finalize(
                  new Response(hit.body, {
                    status: hit.status,
                    headers: {
                      "content-type": "text/html; charset=utf-8",
                      "x-denext-cache": "HIT",
                    },
                  }),
                );
              }
            }

            // Flight: use it when enabled and this route reaches a client
            // module. The build precomputes the boundary routes + client modules;
            // absent those, fall back to the route's own convention directives.
            const useFlight = !!config.flight && !!config.appDir && (
              config.flightRoutes
                ? config.flightRoutes.has(page.route.routePath)
                : routeUsesBoundary(page.route, manifest.directives)
            );
            let pageLoad = config.load;
            if (useFlight) {
              if (config.flightClients) {
                // Tag graph-discovered client islands (imported at most once).
                await tagClientModules(config.flightClients);
                // Auto-register "use server" exports so action props serialize.
                if (config.flightServers) await tagServerModules(config.flightServers);
              } else {
                // Fallback: tag client convention modules as they load.
                pageLoad = taggingLoader(config.load, config.appDir!, manifest.directives!);
              }
            }

            let rendered;
            try {
              rendered = await renderPage(page, request, pageLoad, {
                flight: useFlight,
                messages,
              });
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
              if (!ge) throw pageError; // re-thrown: the top-level catch reports it
              // Handled here (global-error rendered), so report it now — the
              // top-level catch won't see it.
              await reportRequestError(config, pageError, request, page.route.routePath);
              rendered = ge;
            }
            const { html, metadata, status } = rendered;

            // Auto-populate og:image from a dynamic opengraph-image route when
            // the page didn't set one (absolute URL, honoring reverse proxies).
            if (manifest.openGraphImage && !metadata.openGraph?.image) {
              metadata.openGraph = {
                ...metadata.openGraph,
                image: absoluteUrl(request, OPENGRAPH_IMAGE_PATH, {
                  canonicalOrigin: config.canonicalOrigin,
                  trustForwardedHeaders: config.trustForwardedHeaders,
                }),
              };
              // Without a configured canonicalOrigin, the URL above is derived
              // from the request Host — attacker-controllable and NOT part of the
              // cache key. Mark the render dynamic so a poisoned og:image can't be
              // cached and served to everyone. Set `canonicalOrigin` to re-enable
              // caching for such pages.
              if (!config.canonicalOrigin) requestCtx.usedDynamicApi = true;
            }
            // Auto-inject icon / apple-icon / twitter-image links from the file
            // conventions when the page didn't declare its own.
            if (manifest.icon && !metadata.icon && !metadata.icons?.icon) {
              metadata.icons = { ...metadata.icons, icon: ICON_PATH };
            }
            if (manifest.appleIcon && !metadata.icons?.apple) {
              metadata.icons = { ...metadata.icons, apple: APPLE_ICON_PATH };
            }
            if (manifest.twitterImage && !metadata.twitter?.image) {
              metadata.twitter = { ...metadata.twitter, image: TWITTER_IMAGE_PATH };
            }
            // <html lang>: the active locale (i18n) or the framework default.
            const lang = locale || undefined;
            // Public (client-exposable) env for the hydration island.
            const pubEnv = publicEnv();

            // ISR: cache the rendered document when the config opts in — but
            // never when the render read a dynamic API (cookies()/headers()),
            // which implies per-request output that must not be shared.
            if (cacheable && status === 200 && !requestCtx.usedDynamicApi) {
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
                      messages,
                      basePath: basePath || undefined,
                    }
                    : undefined,
                  clientEntry: config.clientEntryFor?.(page.route),
                  styles: config.styleHrefsFor?.(page.route),
                  devScript: config.devScript,
                  flight: rendered.flight,
                  viewport: rendered.viewport,
                  lang,
                  publicEnv: pubEnv,
                });
                // Inherit the tags of any cached data this render read, so
                // revalidateTag(tag) purges the page too — not just the data.
                await config.pageCache!.set(cacheKey, {
                  body: cachedDoc,
                  status,
                  path: pathname,
                  expiresAt,
                  tags: requestCtx.collectedTags ? [...requestCtx.collectedTags] : [],
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
                messages,
                basePath: basePath || undefined,
              }
              : undefined;

            const doc = renderDocument({
              bodyHtml: html,
              metadata,
              hydration,
              clientEntry,
              styles: config.styleHrefsFor?.(page.route),
              devScript: config.devScript,
              flight: rendered.flight,
              viewport: rendered.viewport,
              lang,
              publicEnv: pubEnv,
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
            lang: config.i18n?.defaultLocale,
            publicEnv: publicEnv(),
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
        // Report to instrumentation before rendering the error response.
        await reportRequestError(config, error, request, pathname);
        if (config.onError) return await config.onError(error, request);
        console.error("denext: unhandled error while handling", pathname, error);
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } finally {
        // Drain after() callbacks (and deferred cache invalidations) WITHOUT
        // blocking the response — after() must not delay it. runDeferred swallows
        // every error, so the detached promise can never reject. (On a serverless
        // runtime that freezes the isolate the instant the response is sent, this
        // work is best-effort — the same caveat as the platform's own after().)
        void runDeferred(requestCtx);
      }
    });
  };
}

/**
 * Invoke the configured `onRequestError` hook defensively: a throw from
 * instrumentation is logged, never propagated (it must not mask the original
 * error or take down the response).
 */
async function reportRequestError(
  config: AppConfig,
  error: unknown,
  request: Request,
  routePath: string,
): Promise<void> {
  if (!config.onRequestError) return;
  try {
    await config.onRequestError(error, request, { routePath });
  } catch (hookError) {
    console.error("denext: instrumentation onRequestError() threw", hookError);
  }
}

/** Does any module in this route carry a `"use client"` boundary directive? */
export function routeUsesBoundary(
  route: PageRoute,
  directives: Map<string, Directive> | undefined,
): boolean {
  if (!directives || directives.size === 0) return false;
  const paths = [route.filePath, ...route.layoutChain, ...route.templateChain];
  for (const map of [route.slots, ...(route.layoutSlots ?? [])]) {
    if (!map) continue;
    for (const slot of Object.values(map)) {
      for (const sp of slot.pages) paths.push(sp.filePath);
    }
  }
  return paths.some((p) => directives.get(p) === "client");
}

/**
 * Wrap a loader so that, after loading a `"use client"` module, its exports are
 * tagged as client references (idempotent). The renderer then emits references
 * for them instead of expanding them into the Flight payload. Exported for the
 * static exporter, which renders pages outside the request handler.
 *
 * @param load The underlying module loader.
 * @param appDir The app directory (basis for stable client ids).
 * @param directives The manifest's per-module directive map.
 */
export function taggingLoader(
  load: ModuleLoader,
  appDir: string,
  directives: Map<string, Directive>,
): ModuleLoader {
  return async (path: string) => {
    const mod = await load(path);
    if (directives.get(path) === "client" && mod && typeof mod === "object") {
      tagClientExports(mod as Record<string, unknown>, clientIdFor(appDir, toFileUrl(path).href));
    }
    return mod;
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
