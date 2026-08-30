// The denext application request handler: routes a Request to an API handler,
// a rendered page, a static file, or a 404.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import {
  buildPageContext,
  prerenderPage,
  prerenderPageFlight,
  renderGlobalError,
  renderPage,
  renderPageFlightShell,
  renderPageShell,
  renderRootNotFound,
  resumePageHolesFlightStream,
  resumePageHolesStream,
} from "./render-page.ts";
import { isRedirect } from "../runtime/error-boundary.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
  warnUnkeyedParamReads,
} from "./request-context.ts";
import {
  type HydrationData,
  type IsoNavPayload,
  renderDocument,
  renderHeadContent,
  serializeFlightNav,
  streamFlightDocument,
  streamPageDocument,
  streamPprDocument,
  streamPprFlightDocument,
} from "./document.ts";
import { type CspSetting, resolveCsp, resolveStreamingCsp } from "./csp.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { IslandPayload } from "../jsx/render-to-html-flight.ts";
import { serveStatic } from "./static.ts";
import type { Metadata, ModuleLoader } from "./types.ts";
import { type MiddlewareRunner, redirect, withHeaders } from "./middleware.ts";
import { type I18nConfig, peelLocale, resolveMessages } from "./i18n.ts";
import {
  type CompiledPattern,
  compilePattern,
  fillDestination,
  type HeaderRule,
  type HstsConfig,
  matchPattern,
  type RedirectRule,
  type RewriteRule,
  safeRedirectLocation,
} from "./config.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import { installFetchCache, type PageCache, pageCacheTiming } from "./cache.ts";
import { handleAction, isActionRequest } from "./action-handler.ts";
import { serveMetadataFile } from "./metadata-files.ts";
import { absoluteUrl, requestOrigin } from "./absolute-url.ts";
import { augmentMetadataConventions } from "./augment-metadata.ts";
import { publicEnv, restrictPublicEnv } from "../runtime/public-env.ts";
import { setBasePath } from "../client/navigation.ts";
import type { OnRequestError, RequestErrorContext } from "./instrumentation.ts";
import { tagClientExports, tagClientModules } from "../runtime/client-reference.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { clientIdFor } from "../build/module-graph.ts";
import type { Directive } from "../build/directives.ts";
import { toFileUrl } from "@std/path";

/** Per-request telemetry passed to {@link AppConfig.onRequest}. */
export interface RequestLogInfo {
  /** HTTP method. */
  method: string;
  /** Request pathname. */
  path: string;
  /** Final response status. */
  status: number;
  /** Wall-clock time to produce the response, in milliseconds. */
  durationMs: number;
  /** Per-request correlation id (also the `x-request-id` on an error response). */
  requestId: string;
}

/**
 * Configuration for {@linkcode createApp}: how to resolve the route manifest and
 * load modules, plus optional cross-cutting behavior (request logging, per-request
 * timeout, and the rest). {@linkcode ServeOptions} extends this for the
 * higher-level {@linkcode serve} entry point.
 */
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
  /**
   * Optional plugin claim-hook (e.g. a Pages Router). Called for a request the
   * core App Router did not match, right before static-asset serving and the 404.
   * Returns a {@linkcode Response} to serve it, or `null` to let denext fall
   * through. Wired from the registered plugins (see {@linkcode getPluginRequestHandler}).
   */
  matchExternal?: (
    request: Request,
  ) => Response | null | Promise<Response | null>;
  /** Inline script injected before </body> (dev live-reload, etc.). */
  devScript?: string;
  /**
   * URL of an external same-origin dev script injected before `</body>` (dev
   * live-reload). Preferred over {@link devScript}: an external `<script src>` is
   * CSP-clean under `script-src 'self'`, whereas an inline script is blocked.
   */
  devScriptSrc?: string;
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
  /**
   * Opt-in per-request observability: called once after every response with the
   * method, path, final status, and duration. Errors thrown by it are swallowed
   * (observability must never break the response). A default logger emitting one
   * line per request is used instead when the `DENEXT_LOG` env var is set.
   */
  onRequest?: (info: RequestLogInfo) => void;
  /**
   * Abort a request that runs longer than this many milliseconds, responding
   * 503. The per-request {@link RequestContext} abort signal fires so cooperative
   * work (e.g. `fetch(url, { signal })`) can cancel. Bounds a buffered render or a
   * server action that hangs (e.g. a request-driven unbounded loop); it does not
   * cut off an already-returned streaming body. **Recommended** for production
   * (a slow request body is always bounded separately). Default: no limit.
   */
  requestTimeout?: number;
  /**
   * Opt-in in-process concurrency ceiling: the max number of client requests this
   * instance handles at once. When set (> 0), a request arriving while that many
   * are already in flight is **shed immediately** with a `503` + `Retry-After`
   * (fast-fail, never queued) so a single instance can self-protect against
   * overload. A slot is held from arrival until the response is **produced** —
   * i.e. it bounds render/handler concurrency up to the point the `Response` is
   * returned, released on every exit path (success, error, abort, timeout).
   *
   * It does **not** hold the slot for the lifetime of a streaming body: once the
   * `Response` is returned, the client-read duration of a stream (SSE, a chunked
   * handler body, a large static file) is intentionally *not* counted against this
   * in-process counter — otherwise a slow-reading client could pin slots
   * (slowloris) and long-lived SSE would exhaust the ceiling. Bound streaming-body
   * concurrency and slow-client reads at the edge / load balancer (see
   * DEPLOYMENT.md); this ceiling **complements**, it does not replace, that.
   *
   * Background ISR regeneration (an internal detached task) is exempt. Default: no
   * limit.
   */
  maxConcurrency?: number;
  /**
   * Backstop (ms) to force-release a held concurrency slot when {@link requestTimeout}
   * is disabled (`0`). Only relevant with `maxConcurrency > 0 && requestTimeout === 0`:
   * without a request deadline, a render that never settles would hold its slot
   * forever and could eventually wedge the whole ceiling to 503s. The backstop frees
   * **only the slot** after this many ms (it does not abort the render — the operator
   * opted out of timing requests out). Default: 120000 (2 min).
   */
  slotBackstop?: number;
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
   * Opt-in allowlist of query-parameter names that participate in the ISR page
   * cache key. When set, only these params fork a cached render; every other param
   * is ignored for keying — so high-cardinality junk (`?utm_*`, `?fbclid`, a random
   * cache-buster) can't multiply entries or thrash the LRU. When omitted (default),
   * ALL params participate, preserving existing behavior. Values still key
   * verbatim; only which names count is narrowed. A param not in the allowlist
   * still reaches the render (via `searchParams`) — it just doesn't fork the key,
   * so list every param whose value changes cacheable output.
   */
  cacheKeyParams?: string[];
  /**
   * Extra origins allowed to invoke Server Actions, beyond the request's own
   * Host (for reverse-proxy / multi-host deployments). Actions are same-origin
   * only by default.
   */
  allowedOrigins?: string[];
  /**
   * Max Server Action request body size in bytes (default 1 MiB, matching Next.js).
   * Raise this only for actions that accept large payloads (e.g. multipart file
   * uploads).
   */
  actionMaxBodyBytes?: number;
  /**
   * An explicit public origin (e.g. `"https://example.com"`) used to build
   * absolute URLs (auto-populated `og:image`, canonical). Overrides request
   * headers — the most robust option when the origin is fixed. Also makes Server
   * Action origin checks scheme-strict (rejects an `http` origin for an `https` app).
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
  /**
   * Enable Cache Components / Partial Prerendering (Next.js 16). When on (and a
   * {@link pageCache} is present), a cacheable GET renders a request-independent
   * static shell — cached once — with per-request dynamic holes (subtrees that
   * read `cookies()`/`headers()` behind a Suspense boundary) spliced in on every
   * request. Off by default; when off the render path is unchanged.
   */
  cacheComponents?: boolean;
  /**
   * App-wide Content-Security-Policy default (`denext.config` `csp`): `"strict"`
   * (default), `"off"` (no CSP header), or a {@link CspSetting} object of global
   * opt-ins. A route's own `csp` export overrides it. Absent ⇒ `"strict"`.
   */
  csp?: CspSetting;
  /**
   * Incremental (Suspense) streaming, **on by default** (the top-level `streaming`
   * config); set `false` to opt out (buffer the whole document before responding). Streamed
   * responses carry the same strict hash-based CSP as buffered ones (the swap runtime
   * is a hashed constant), survive a failing Suspense boundary (its fallback stays),
   * and cover Flight (`"use client"`) routes via their own path. Streaming applies to
   * hard-navigation/initial GET renders that aren't ISR/PPR-cached (a cached shell or
   * a soft navigation takes its own path first); a `csp: "off"` route emits no CSP
   * header, as when buffered.
   */
  streaming?: boolean;
  /**
   * `Strict-Transport-Security` tuning (`denext.config` `hsts`): default
   * host-only `max-age=31536000`, opt into `includeSubDomains`/`preload`, or
   * `false` to omit the header.
   */
  hsts?: HstsConfig | false;
  /**
   * Allowlist of public-env var names to embed in each page's env island (the
   * build's referenced set ∪ the `publicEnv` config). When set, only these
   * `NEXT_PUBLIC_`/`DENEXT_PUBLIC_` vars ship to the browser instead of every
   * prefixed one. Undefined ⇒ ship all (dev, or no build scan).
   */
  publicEnvKeys?: readonly string[];
}

/** An HTTP request handler that resolves a {@linkcode Request} to a {@linkcode Response}. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Build a request handler from app configuration. */
/**
 * In-flight ISR renders, keyed by page cache key. Followers await the leader and
 * re-read the cache instead of rendering in parallel (stampede protection). It
 * only ever coordinates waiting — a live render is never shared across requests.
 */
const pageRenderInFlight = new Map<string, Promise<void>>();

/**
 * Cache keys with a stale-while-revalidate background regeneration in flight, so a
 * burst of stale hits triggers at most one background re-render per key.
 */
const pageRegenInFlight = new Set<string>();

/**
 * Build a stable page cache key from the path and query string. The query params
 * are sorted (by name, then value) so `?a=1&b=2` and `?b=2&a=1` map to ONE cache
 * entry instead of forking it — and so an attacker can't multiply entries (or
 * thrash the in-memory LRU) merely by permuting parameter order. Values are kept
 * verbatim (they legitimately change the render); only their order is normalized.
 *
 * When `allowParams` is given (opt-in, {@link AppConfig.cacheKeyParams}), only those
 * param names participate in the key — every other param is dropped from the key
 * (but still reaches the render), so high-cardinality junk params can't fork the
 * cache or thrash the LRU. Omitted ⇒ all params participate (default).
 */
function pageCacheKey(
  pathname: string,
  searchParams: URLSearchParams,
  allowParams?: string[],
): string {
  let entries = [...searchParams.entries()];
  if (allowParams) {
    const allow = new Set(allowParams);
    entries = entries.filter(([name]) => allow.has(name));
  }
  if (entries.length === 0) return pathname;
  // URLSearchParams.sort() orders by name only and keeps insertion order among
  // equal names, so sort explicitly by name then value for a fully stable key.
  entries.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  );
  return `${pathname}?${new URLSearchParams(entries).toString()}`;
}

/** Default per-request deadline (ms). Bounds a runaway/wedged render or action. */
const DEFAULT_REQUEST_TIMEOUT = 30_000;

/**
 * Per-process unguessable marker for the in-process ISR background-regen loopback.
 * A background regen is exempt from the concurrency ceiling, the request timeout,
 * the ISR cache read, and stampede single-flight — so the marker MUST NOT be
 * client-forgeable. It lives only in this process and is set on the internal
 * loopback request (never sent over the wire); an external `x-denext-regen` header
 * carries some other value and is therefore ignored (H2).
 */
const REGEN_TOKEN: string = crypto.randomUUID();
/** Header carrying {@link REGEN_TOKEN} on the internal regen loopback. */
const REGEN_HEADER = "x-denext-regen";

/**
 * Default backstop (ms) that force-frees a held concurrency slot when the request
 * timeout is disabled. It never aborts the render — it only releases the counter so a
 * never-settling request can't permanently wedge the concurrency ceiling into 503s.
 */
const DEFAULT_SLOT_BACKSTOP = 120_000;

/** True for an abort (client disconnect / request timeout), not a real error. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string } | null)?.name === "AbortError";
}

/** Await `promise`, but stop waiting early if `signal` aborts. */
function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | void> {
  if (!signal || signal.aborted) {
    return signal?.aborted ? Promise.resolve() : promise;
  }
  return Promise.race([
    promise,
    new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    ),
  ]);
}

/**
 * Build the core request handler from an {@linkcode AppConfig}: routing,
 * SSR/streaming, API routes, the image endpoint, static files, caching, and the
 * optional request-logging/timeout wrappers. Most apps use {@linkcode serve}
 * instead; use `createApp` directly to embed denext in a custom server.
 *
 * @param config How to resolve the manifest, load modules, and behave.
 * @returns A `(Request) => Promise<Response>` handler.
 */
export function createApp(config: AppConfig): RequestHandler {
  // Install automatic fetch() caching (uncached by default; opt in per fetch via
  // next:{revalidate,tags} / cache:"force-cache"). Idempotent + a pass-through
  // outside a request, so it is safe to call on every createApp.
  installFetchCache();
  // Compile config-driven redirect/rewrite/header patterns lazily on first use
  // (the dev server resolves rules asynchronously after createApp is called).
  const basePath = config.basePath?.replace(/\/$/, "") || "";
  // Make server-rendered <Link>s prefix basePath (client reads it from hydration).
  setBasePath(basePath);
  // Opt-in in-process concurrency ceiling (see AppConfig.maxConcurrency). A single
  // per-app counter of in-flight client requests; 0 disables. Fast-fail 503 when at
  // capacity — deliberately not a queue (queuing just moves the overload).
  const maxConcurrency = config.maxConcurrency && config.maxConcurrency > 0
    ? Math.floor(config.maxConcurrency)
    : 0;
  let inFlight = 0;
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
    // A background ISR regen (x-denext-regen) is a detached internal task, not a
    // client request — exempt from the concurrency ceiling and the client timeout.
    const isBackgroundRegen = originalRequest.headers.get(REGEN_HEADER) === REGEN_TOKEN;
    // Concurrency ceiling: shed immediately (503 + Retry-After) when already at
    // capacity, before doing any per-request work. Otherwise claim a slot, released
    // on every exit path via the returned promise's finally (see below).
    if (maxConcurrency > 0 && !isBackgroundRegen) {
      if (inFlight >= maxConcurrency) {
        const res = new Response("Service Unavailable", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "retry-after": "1",
          },
        });
        // Surface shed requests to observability (0ms, no per-request context).
        const shedLog = config.onRequest ??
          (REQUEST_LOG_ENABLED ? defaultRequestLog : undefined);
        if (shedLog) {
          try {
            shedLog({
              method: originalRequest.method,
              path: new URL(originalRequest.url).pathname,
              status: 503,
              durationMs: 0,
              requestId: "shed",
            });
          } catch { /* observability must never break the response */ }
        }
        return Promise.resolve(res);
      }
      inFlight++;
    }
    // Establish the per-request async context so cookies()/headers() work in
    // server components, route handlers, and middleware.
    const requestCtx = createRequestContext(originalRequest);
    const startedAt = performance.now();
    // Per-request abort signal — fires on client disconnect or (when configured)
    // request timeout. Exposed on the context so handlers/components can thread it
    // into their own fetch()es for cooperative cancellation.
    const controller = new AbortController();
    linkAbort(originalRequest.signal, controller);
    requestCtx.signal = controller.signal;

    let pipeline = runWithContext(requestCtx, async (): Promise<Response> => {
      let request = originalRequest;
      let url = new URL(request.url);
      let pathname = url.pathname;
      let injectedHeaders: Headers | undefined;
      // Set when this request is the ISR "leader" for a cache key — released in
      // the finally so concurrent requests for the same key stop waiting.
      let releasePageLeader: (() => void) | undefined;
      // Tracks what the request was dispatched to, so the top-level catch can label
      // the error's `routeType` for onRequestError (API errors bubble here).
      let dispatchRouteType: RequestErrorContext["routeType"] = "render";

      try {
        // Config-driven URL handling (static denext.config rules), before routing.
        // Skip framework asset paths and requests for files with an extension.
        const isFrameworkPath = pathname.startsWith("/_denext");
        const isFile = /\.[^/]+$/.test(pathname);

        // trailing-slash normalization → 308 redirect to the canonical form.
        if (
          config.trailingSlash !== undefined && !isFrameworkPath && !isFile &&
          pathname !== "/"
        ) {
          const hasSlash = pathname.endsWith("/");
          if (config.trailingSlash && !hasSlash) {
            return redirect(
              safeRedirectLocation(pathname + "/") + url.search,
              308,
            );
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
            for (const { key, value } of rule.headers) {
              injectedHeaders.append(key, value);
            }
          }
        }

        // Rewrites: internally route as the destination (no client redirect).
        for (const { pattern, rule } of rules.rewrites) {
          const params = matchPattern(pattern, pathname);
          if (params) {
            url = new URL(
              fillDestination(rule.destination, params),
              url.origin,
            );
            pathname = url.pathname;
            request = new Request(url.toString(), request);
            break;
          }
        }

        // Root middleware runs before routing.
        const runner = config.getMiddleware ? await config.getMiddleware() : null;
        if (runner) {
          // Label an error thrown inside middleware as "proxy" (Next's routeType for
          // middleware/proxy). Reset to "render" once it completes so a later
          // render/route error is labeled correctly.
          dispatchRouteType = "proxy";
          const outcome = await runner(request);
          dispatchRouteType = "render";
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
          // Apply request-header overrides from NextResponse.next({ request }) so
          // the downstream route/handler sees the modified headers.
          if (outcome.requestHeaders) {
            request = new Request(request, { headers: outcome.requestHeaders });
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
          return finalize(
            await handleAction(request, {
              allowedOrigins: config.allowedOrigins,
              canonicalOrigin: config.canonicalOrigin,
              trustForwardedHeaders: config.trustForwardedHeaders,
              maxBodyBytes: config.actionMaxBodyBytes,
              // A thrown Server Action returns a normal 500 here, so report it to
              // instrumentation ourselves — it never reaches the top-level catch (M2).
              onError: (err) =>
                reportRequestError(config, err, request, pathname, {
                  routeType: "action",
                }),
            }),
          );
        }

        const manifest = await config.getManifest();

        // Metadata files (sitemap.xml / robots.txt / manifest.webmanifest / favicon).
        if (request.method === "GET" || request.method === "HEAD") {
          const metaFile = await serveMetadataFile(
            manifest,
            pathname,
            config.load,
            requestOrigin(request, {
              canonicalOrigin: config.canonicalOrigin,
              trustForwardedHeaders: config.trustForwardedHeaders,
            }),
          );
          if (metaFile) return finalize(metaFile);
        }

        // Peel an optional locale prefix off the path (i18n). Matching runs
        // against the stripped path; the locale is merged into route params.
        const localeInfo = config.i18n ? peelLocale(pathname, config.i18n) : null;
        const routingPath = localeInfo ? localeInfo.rest : pathname;

        // 1. API routes.
        const api = matchApi(manifest, routingPath);
        if (api) {
          dispatchRouteType = "route"; // so a thrown API handler is labeled "route"
          return finalize(await handleApi(api, request, config.load));
        }

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
            const locale = localeInfo?.locale ?? config.i18n?.defaultLocale ??
              "";
            const messages: Messages | undefined = config.i18n?.messages
              ? resolveMessages(config.i18n, locale)
              : undefined;

            // Cache Components / PPR: stream a cached shell for THIS request. Rebuild
            // its <head> (per-request generateMetadata, re-merging the shell's static
            // head extras), then stream each dynamic hole into its placeholder as it
            // resolves, and finally the hydration scripts + client entry — LAST, so
            // the client hydrates the COMPLETE document (same as the buffered path).
            // The streamed response carries the same strict hash-based CSP as a
            // buffered one, computed from the buffered shell prefix (head + shell body)
            // — the swap runtime is a hashed constant (see resolveStreamingCsp).
            const servePprStream = async (
              shellBody: string,
              holeIds: string[],
              headExtras: string | undefined,
              inTreeTitle: string | undefined,
              cacheState: "HIT" | "STALE" | "MISS",
              loader: typeof config.load,
              routeCsp: CspSetting | undefined,
            ): Promise<Response> => {
              const { holes, metadata, viewport } = await resumePageHolesStream(
                page,
                request,
                loader,
                holeIds,
                { messages, signal: requestCtx.signal },
              );
              if (inTreeTitle !== undefined) metadata.title = inTreeTitle;
              if (headExtras) {
                metadata.head = (metadata.head ?? "") + headExtras;
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
              const styles = config.styleHrefsFor?.(page.route);
              // Dev render-mode telemetry: a PPR shell serves streamed, with holes.
              requestCtx.renderStreamed = true;
              requestCtx.renderCache = cacheState;
              const stream = streamPprDocument({
                bodyHtml: shellBody,
                metadata,
                viewport,
                hydration,
                clientEntry,
                styles,
                devScript: config.devScript,
                devScriptSrc: config.devScriptSrc,
                lang: locale || undefined,
                publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
                holes,
                signal: requestCtx.signal,
              });
              // The CSP is computed over the buffered shell prefix (head + shell body),
              // which holds every framework inline <style>; the streamed holes add no
              // inline <style>/<script>, so this policy is complete for the whole doc.
              const shellPrefix = renderHeadContent(metadata, viewport, styles) + shellBody;
              const csp = await resolveStreamingCsp(shellPrefix, routeCsp, config.csp);
              const headers = htmlHeaders(csp, {
                "x-denext-cache": cacheState,
                "cache-control": "private, no-store",
              });
              return finalize(new Response(stream, { status: 200, headers }));
            };

            // Auto-populate og:image (from a dynamic opengraph-image route) + icon /
            // apple-icon / twitter-image links from the file conventions when the page
            // didn't declare its own. Applied to whichever path serves the page
            // (buffered, streamed shell, or Flight shell) so the metadata is identical
            // regardless of how the document is delivered. The og:image branch may mark
            // the render dynamic (a Host-derived URL is not part of the cache key).
            const augmentMetadata = (metadata: Metadata): void => {
              augmentMetadataConventions(metadata, {
                manifest,
                route: page.route,
                i18n: config.i18n,
                localeInfo,
                absolutize: (path) =>
                  absoluteUrl(request, path, {
                    canonicalOrigin: config.canonicalOrigin,
                    trustForwardedHeaders: config.trustForwardedHeaders,
                  }),
                // A Host-derived URL isn't part of the cache key; a pinned
                // canonical origin is stable, so it stays cacheable.
                onHostDerived: config.canonicalOrigin ? undefined : () => {
                  requestCtx.usedDynamicApi = true;
                },
              });
            };

            // Cache Components / PPR for FLIGHT ("use client") routes: like
            // `servePprStream`, but the cached shell also carries its Flight tree,
            // islands, and signal state. The per-request resume fills the shell's
            // Flight holes with its subtrees and merges islands/signals, emitting the
            // same trailing #__denext_flight / #__denext_islands / #__denext_state
            // payload a non-PPR streamed Flight route emits — so the client is
            // unchanged (it never learns the shell was cached).
            const servePprFlightStream = async (
              shellBody: string,
              holeIds: string[],
              shellFlight: FlightNode,
              shellIslands: IslandPayload[],
              shellSignalState: Record<string, unknown>,
              headExtras: string | undefined,
              inTreeTitle: string | undefined,
              cacheState: "HIT" | "STALE" | "MISS",
              loader: typeof config.load,
              routeCsp: CspSetting | undefined,
            ): Promise<Response> => {
              const resume = await resumePageHolesFlightStream(
                page,
                request,
                loader,
                holeIds,
                { messages, signal: requestCtx.signal },
              );
              const { metadata, viewport } = resume;
              if (inTreeTitle !== undefined) metadata.title = inTreeTitle;
              if (headExtras) metadata.head = (metadata.head ?? "") + headExtras;
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
              const styles = config.styleHrefsFor?.(page.route);
              // Dev render-mode telemetry: a Flight PPR shell serves streamed, with holes.
              requestCtx.renderStreamed = true;
              requestCtx.renderCache = cacheState;
              const stream = streamPprFlightDocument({
                shellBody,
                shellFlight,
                shellIslands,
                shellSignalState,
                resume: {
                  holes: resume.holes,
                  islands: resume.islands,
                  finishSignals: resume.finishSignals,
                },
                metadata,
                viewport,
                hydration,
                clientEntry,
                styles,
                devScript: config.devScript,
                devScriptSrc: config.devScriptSrc,
                lang: locale || undefined,
                publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
                signal: requestCtx.signal,
              });
              const shellPrefix = renderHeadContent(metadata, viewport, styles) + shellBody;
              const csp = await resolveStreamingCsp(shellPrefix, routeCsp, config.csp);
              const headers = htmlHeaders(csp, {
                "x-denext-cache": cacheState,
                "cache-control": "private, no-store",
              });
              return finalize(new Response(stream, { status: 200, headers }));
            };

            // Flight: use it when enabled and this route reaches a client module. The
            // build precomputes the boundary routes + client modules; absent those,
            // fall back to the route's own convention directives. Computed BEFORE the
            // cache-hit check so a (Flight PPR) cache hit resumes with tagged client
            // modules — a cold hit would otherwise carve no islands.
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
                if (config.flightServers) {
                  await tagServerModules(config.flightServers);
                }
              } else {
                // Fallback: tag client convention modules as they load.
                pageLoad = taggingLoader(
                  config.load,
                  config.appDir!,
                  manifest.directives!,
                );
              }
            }

            // ISR: serve a cached render when available (impersonal GETs). A
            // background-regeneration request (x-denext-regen) skips the cache read
            // so it always renders fresh and repopulates the entry.
            const isRegen = request.headers.get(REGEN_HEADER) === REGEN_TOKEN;
            const cacheable = config.pageCache && !soft &&
              request.method === "GET";
            const cacheKey = pageCacheKey(
              pathname,
              url.searchParams,
              config.cacheKeyParams,
            );
            // When the key is narrowed, record which searchParams the render reads so
            // a whole-body-cached render can dev-warn if it baked in a dropped param.
            if (cacheable && config.cacheKeyParams) requestCtx.trackParamReads = true;
            if (cacheable) {
              const hit = isRegen ? undefined : await config.pageCache!.get(cacheKey);
              if (hit) {
                // Stale-while-revalidate: past staleAt, serve the stale render now
                // and regenerate in the background (at most one regen per key).
                const stale = hit.staleAt != null && hit.staleAt <= Date.now();
                if (stale && !pageRegenInFlight.has(cacheKey)) {
                  pageRegenInFlight.add(cacheKey);
                  // The regen render runs with requestTimeout disabled (it serves no
                  // client), so give it its own hard deadline: on expiry, free the
                  // key AND abort the render's cooperative signal. Without this, a
                  // hung upstream (`fetch` has no default timeout) would leak the
                  // render forever and — because the `.finally` that clears the key
                  // never runs — permanently freeze staleness for this key (H2).
                  const regenController = new AbortController();
                  const regenReq = new Request(request.url, {
                    method: "GET",
                    headers: new Headers(request.headers),
                    signal: regenController.signal,
                  });
                  regenReq.headers.set(REGEN_HEADER, REGEN_TOKEN);
                  const regenDeadline = config.requestTimeout ??
                    DEFAULT_REQUEST_TIMEOUT;
                  const timer = regenDeadline > 0
                    ? setTimeout(() => {
                      pageRegenInFlight.delete(cacheKey); // free the key for a retry
                      regenController.abort(); // reclaim the hung render
                    }, regenDeadline)
                    : undefined;
                  if (timer !== undefined) Deno.unrefTimer(timer);
                  Promise.resolve()
                    .then(() => handle(regenReq))
                    .catch(() => {})
                    .finally(() => {
                      if (timer !== undefined) clearTimeout(timer);
                      pageRegenInFlight.delete(cacheKey);
                    });
                }
                const cacheState = stale ? "STALE" : "HIT";
                requestCtx.renderCache = cacheState; // dev render-mode telemetry
                // Cache Components / PPR (Flight route): the cached shell also carries
                // its Flight tree/islands/signal state — resume the holes, fill them,
                // and stream with the trailing Flight tail.
                if (
                  hit.flightShell !== undefined && hit.holeIds && hit.holeIds.length > 0
                ) {
                  return servePprFlightStream(
                    hit.body,
                    hit.holeIds,
                    hit.flightShell,
                    hit.flightIslands ?? [],
                    hit.flightSignalState ?? {},
                    hit.headExtras,
                    hit.inTreeTitle,
                    cacheState,
                    pageLoad,
                    hit.routeCsp,
                  );
                }
                // Cache Components / PPR: a cached *shell body* — stream it with this
                // request's holes and per-request <head>. The shell was cached once;
                // only the holes and metadata vary.
                if (hit.holeIds && hit.holeIds.length > 0) {
                  return servePprStream(
                    hit.body, // the shell BODY (holes as placeholders), not a document
                    hit.holeIds,
                    hit.headExtras,
                    hit.inTreeTitle,
                    cacheState,
                    config.load,
                    hit.routeCsp,
                  );
                }
                // A fully-static cached page: serve verbatim. Route through finalize
                // so middleware headers (e.g. an app CSP) override the stored default.
                const hitHeaders = htmlHeaders(hit.csp, {
                  "x-denext-cache": cacheState,
                });
                return finalize(
                  new Response(hit.body, {
                    status: hit.status,
                    headers: hitHeaders,
                  }),
                );
              }
              // Single-flight (stampede protection): if another request is already
              // rendering this key, wait for it and re-read the cache rather than
              // rendering in parallel. We NEVER share a live render — the leader's
              // render may read cookies() and be per-user; we only serve what it
              // actually cached (provably impersonal). If nothing was cached (the
              // leader's render was dynamic), we fall through and render our own.
              // A background regen (x-denext-regen) is already single-flighted by
              // pageRegenInFlight and serves no client, so it does NOT take the
              // leader lock: otherwise a hung regen would pin the lock and block
              // every future foreground MISS and regen for this key (H2).
              const leaderDone = isRegen ? undefined : pageRenderInFlight.get(cacheKey);
              if (leaderDone) {
                // Don't let a hung leader pin this follower — race the wait against
                // the follower's own abort (disconnect / timeout).
                await raceAbort(leaderDone, requestCtx.signal);
                requestCtx.signal?.throwIfAborted();
                const retry = await config.pageCache!.get(cacheKey);
                if (retry) {
                  return finalize(
                    new Response(retry.body, {
                      status: retry.status,
                      headers: htmlHeaders(retry.csp, {
                        "x-denext-cache": "HIT",
                      }),
                    }),
                  );
                }
              } else if (!isRegen) {
                let release!: () => void;
                const done = new Promise<void>((r) => (release = r));
                pageRenderInFlight.set(cacheKey, done);
                releasePageLeader = () => {
                  pageRenderInFlight.delete(cacheKey);
                  release();
                };
              }
            }

            // Cache Components / PPR (experimental, gated): for a page that is
            // ALREADY cacheable (opted in via revalidate/force-static), render a
            // request-independent static shell — cached once — with any dynamic
            // subtrees (cookies()/headers() behind a Suspense) as per-request holes
            // spliced in on every request. This lifts the all-or-nothing dynamic
            // disqualification: such a page was previously not cached at all. Flight
            // routes and un-prerenderable pages fall through to the normal render.
            if (config.cacheComponents && cacheable && !useFlight) {
              const pre = await prerenderPage(page, request, pageLoad, {
                messages,
                signal: requestCtx.signal,
              }).catch((err) => {
                if (isAbortError(err)) throw err;
                return null; // any prerender complication → normal render below
              });
              const pprTiming = pre && !pre.dynamic ? pageCacheTiming(pre.config) : null;
              if (pre && !pre.dynamic && pprTiming !== null) {
                // Tags accrued by the static shell (its `use cache` islands), before
                // the per-request hole render adds its own.
                const shellTags = requestCtx.collectedTags ? [...requestCtx.collectedTags] : [];
                if (pre.holeIds.length > 0) {
                  // A shell WITH holes: cache the request-independent shell BODY (the
                  // head + holes are rebuilt per request) and stream it for THIS
                  // request. The head extras/title let a later hit rebuild the head.
                  await config.pageCache!.set(cacheKey, {
                    body: pre.shellBody, // the shell BODY (holes as placeholders)
                    status: 200,
                    path: pathname,
                    expiresAt: pprTiming.expiresAt,
                    staleAt: pprTiming.staleAt,
                    tags: shellTags,
                    holeIds: pre.holeIds,
                    routeCsp: pre.config.csp,
                    headExtras: pre.headExtras,
                    inTreeTitle: pre.inTreeTitle,
                  });
                  return servePprStream(
                    pre.shellBody,
                    pre.holeIds,
                    pre.headExtras,
                    pre.inTreeTitle,
                    "MISS",
                    pageLoad,
                    pre.config.csp,
                  );
                }
                // A fully-static shell (no holes): its metadata has no dynamic reads,
                // so render + cache the whole document and serve it verbatim.
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
                const shellDoc = renderDocument({
                  bodyHtml: pre.shellBody,
                  metadata: pre.metadata,
                  hydration,
                  clientEntry,
                  styles: config.styleHrefsFor?.(page.route),
                  devScript: config.devScript,
                  devScriptSrc: config.devScriptSrc,
                  viewport: pre.viewport,
                  lang: locale || undefined,
                  publicEnv: restrictPublicEnv(
                    publicEnv(),
                    config.publicEnvKeys,
                  ),
                });
                const csp = await resolveCsp(
                  shellDoc,
                  pre.config.csp,
                  config.csp,
                );
                // Backstop: a no-holes "static" shell that nonetheless read a dynamic
                // API (e.g. a `use cache` body that reads cookies — which now throws,
                // but defense-in-depth) is request-specific. Serve it to THIS request,
                // but never cache it for others. Mirrors the normal path's guard.
                if (!requestCtx.usedDynamicApi) {
                  if (config.cacheKeyParams) {
                    warnUnkeyedParamReads(requestCtx, config.cacheKeyParams);
                  }
                  await config.pageCache!.set(cacheKey, {
                    body: shellDoc,
                    status: 200,
                    path: pathname,
                    expiresAt: pprTiming.expiresAt,
                    staleAt: pprTiming.staleAt,
                    tags: shellTags,
                    csp,
                  });
                }
                return finalize(
                  new Response(shellDoc, {
                    status: 200,
                    headers: htmlHeaders(csp, { "x-denext-cache": "MISS" }),
                  }),
                );
              }
              // Not prerenderable (fully dynamic) or not cacheable: normal render.
            }

            // Cache Components / PPR for FLIGHT ("use client") routes: the same
            // request-independent-shell + per-request-holes model as above, but the
            // shell also carries its Flight tree, islands, and signal state (cached
            // alongside the body) so a client-island route can be partially prerendered
            // — the "on by default" unlock for real apps. Behind `cacheComponents`.
            if (config.cacheComponents && cacheable && useFlight) {
              const pre = await prerenderPageFlight(page, request, pageLoad, {
                messages,
                signal: requestCtx.signal,
              }).catch((err) => {
                if (isAbortError(err)) throw err;
                return null; // any prerender complication → normal render below
              });
              const pprTiming = pre && !pre.dynamic ? pageCacheTiming(pre.config) : null;
              if (pre && !pre.dynamic && pprTiming !== null) {
                const shellTags = requestCtx.collectedTags ? [...requestCtx.collectedTags] : [];
                if (pre.holeIds.length > 0) {
                  // A Flight shell WITH holes: cache the request-independent shell body
                  // AND its Flight payload (tree/islands/signal state), then stream it
                  // for THIS request with the holes filled in.
                  await config.pageCache!.set(cacheKey, {
                    body: pre.shellBody,
                    status: 200,
                    path: pathname,
                    expiresAt: pprTiming.expiresAt,
                    staleAt: pprTiming.staleAt,
                    tags: shellTags,
                    holeIds: pre.holeIds,
                    routeCsp: pre.config.csp,
                    headExtras: pre.headExtras,
                    inTreeTitle: pre.inTreeTitle,
                    flightShell: pre.flightShell,
                    flightIslands: pre.flightIslands,
                    flightSignalState: pre.flightSignalState,
                  });
                  return servePprFlightStream(
                    pre.shellBody,
                    pre.holeIds,
                    pre.flightShell,
                    pre.flightIslands,
                    pre.flightSignalState,
                    pre.headExtras,
                    pre.inTreeTitle,
                    "MISS",
                    pageLoad,
                    pre.config.csp,
                  );
                }
                // A fully-static Flight shell (no holes): render + cache the whole
                // document (its Flight/islands/signal-state tail emitted inline) and
                // serve it verbatim.
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
                const shellDoc = renderDocument({
                  bodyHtml: pre.shellBody,
                  metadata: pre.metadata,
                  hydration,
                  clientEntry,
                  styles: config.styleHrefsFor?.(page.route),
                  devScript: config.devScript,
                  devScriptSrc: config.devScriptSrc,
                  viewport: pre.viewport,
                  lang: locale || undefined,
                  publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
                  flight: pre.flightShell,
                  islands: pre.flightIslands.length > 0 ? pre.flightIslands : undefined,
                  signalState: Object.keys(pre.flightSignalState).length > 0
                    ? pre.flightSignalState
                    : undefined,
                });
                const csp = await resolveCsp(shellDoc, pre.config.csp, config.csp);
                if (!requestCtx.usedDynamicApi) {
                  if (config.cacheKeyParams) {
                    warnUnkeyedParamReads(requestCtx, config.cacheKeyParams);
                  }
                  await config.pageCache!.set(cacheKey, {
                    body: shellDoc,
                    status: 200,
                    path: pathname,
                    expiresAt: pprTiming.expiresAt,
                    staleAt: pprTiming.staleAt,
                    tags: shellTags,
                    csp,
                  });
                }
                return finalize(
                  new Response(shellDoc, {
                    status: 200,
                    headers: htmlHeaders(csp, { "x-denext-cache": "MISS" }),
                  }),
                );
              }
              // Not prerenderable (fully dynamic) or not cacheable: normal render.
            }

            let rendered;
            // Errors an error.tsx boundary catches during the render: the render
            // succeeds (the boundary shows its fallback), so without this they'd be
            // invisible to instrumentation. Collected here, reported after the render.
            const boundaryErrors: unknown[] = [];
            try {
              // Compose the tree once (metadata/config resolved); used by whichever
              // render mode runs below, so streaming vs buffering costs no re-compose.
              // onCaughtError is wired here because buildPageContext creates the
              // error.tsx ErrorBoundary that carries it.
              const prepared = await buildPageContext(page, request, pageLoad, {
                flight: useFlight,
                messages,
                signal: requestCtx.signal,
                onCaughtError: (e) => boundaryErrors.push(e),
              });

              // Streaming is on by default but yields to ISR: a route that opts into
              // page caching (revalidate/force-static → non-null timing) is buffered
              // and cached (a streamed no-store response would never populate the
              // cache), while everything else streams. PPR (cacheComponents) already
              // handled a cacheable route above; a plain cacheable route falls here.
              const willIsrCache = cacheable && pageCacheTiming(prepared.config) !== null;

              // Incremental streaming: flush the shell and stream each
              // Suspense boundary as it resolves. The streamed response carries the
              // same strict hash-based CSP as a buffered one — computed from the
              // buffered shell prefix (head + shell), with the swap runtime a hashed
              // constant (resolveStreamingCsp). Flight routes are handled separately.
              if (
                config.streaming !== false && !soft && !willIsrCache && !useFlight &&
                request.method === "GET"
              ) {
                const shellResult = await renderPageShell(
                  page,
                  request,
                  pageLoad,
                  {
                    flight: useFlight,
                    messages,
                    signal: requestCtx.signal,
                    onCaughtError: (e) => boundaryErrors.push(e),
                  },
                  prepared,
                );
                // Report the shell's boundary catches (holes stream after the
                // response, so their late catches are logged by H1, not reported here).
                for (const be of boundaryErrors) {
                  await reportRequestError(
                    config,
                    be,
                    request,
                    page.route.routePath,
                    {
                      routeType: "render",
                      renderSource: "server-rendering",
                    },
                  );
                }
                augmentMetadata(shellResult.metadata); // og:image + icon conventions
                const clientEntry = config.clientEntryFor?.(page.route);
                const streamLang = locale || undefined;
                const streamStyles = config.styleHrefsFor?.(page.route);
                const streamHydration: HydrationData | undefined = clientEntry
                  ? {
                    params: page.params,
                    searchParams: url.searchParams.toString(),
                    pathname,
                    messages,
                    basePath: basePath || undefined,
                  }
                  : undefined;
                const docOpts = {
                  metadata: shellResult.metadata,
                  viewport: shellResult.viewport,
                  hydration: streamHydration,
                  clientEntry,
                  styles: streamStyles,
                  devScript: config.devScript,
                  devScriptSrc: config.devScriptSrc,
                  lang: streamLang,
                  publicEnv: restrictPublicEnv(
                    publicEnv(),
                    config.publicEnvKeys,
                  ),
                };
                // Streamed responses are always per-request (never ISR-cached).
                const streamHeaders = {
                  "cache-control": "private, no-store",
                };
                // Only stream when the shell has deferred (Suspense) holes — a fully
                // synchronous page has nothing to stream, so buffer it (no re-render)
                // and keep the ordinary buffered headers: a static page stays
                // shared-cacheable, a dynamic (cookies/headers) page gets no-store +
                // Vary: Cookie (M1). Streaming would force no-store on every page.
                if (shellResult.shell && shellResult.shell.holes.size > 0) {
                  // Dev render-mode telemetry: this response streams (Suspense holes).
                  requestCtx.renderStreamed = true;
                  const stream = streamPageDocument({
                    ...docOpts,
                    shell: shellResult.shell,
                    signal: requestCtx.signal,
                  });
                  // CSP from the buffered shell prefix (head + shell): it holds every
                  // framework inline <style>; streamed holes add no inline style/script.
                  const shellPrefix =
                    renderHeadContent(shellResult.metadata, shellResult.viewport, streamStyles) +
                    shellResult.shell.shell;
                  const csp = await resolveStreamingCsp(
                    shellPrefix,
                    prepared.config.csp,
                    config.csp,
                  );
                  return finalize(
                    new Response(stream, {
                      status: 200,
                      headers: htmlHeaders(csp, streamHeaders),
                    }),
                  );
                }
                if (shellResult.shell) {
                  // No holes: a complete buffered document. Same header logic as the
                  // main buffered path (a dynamic read → per-user, so no-store + Vary).
                  const doc = renderDocument({
                    ...docOpts,
                    bodyHtml: shellResult.shell.shell,
                  });
                  const csp = await resolveCsp(doc, prepared.config.csp, config.csp);
                  const dynamic = requestCtx.usedDynamicApi === true;
                  const bufHeaders = dynamic
                    ? { "cache-control": "private, no-store", vary: "x-denext-nav, Cookie" }
                    : undefined;
                  return finalize(
                    new Response(doc, { status: 200, headers: htmlHeaders(csp, bufHeaders) }),
                  );
                }
                // A control signal (notFound/forbidden/unauthorized) fired in the
                // shell before any bytes flushed → a buffered signal-UI page. It's a
                // complete buffered document, so it gets the normal buffered CSP.
                const doc = renderDocument({
                  ...docOpts,
                  bodyHtml: shellResult.html ?? "",
                });
                const docCsp = await resolveCsp(doc, prepared.config.csp, config.csp);
                return finalize(
                  new Response(doc, {
                    status: shellResult.status,
                    headers: htmlHeaders(docCsp, streamHeaders),
                  }),
                );
              }

              // Incremental streaming for FLIGHT ("use client") routes: the same
              // shell-first, holes-stream-in model, but rendered with the Flight
              // renderer so the trailing #__denext_flight / #__denext_islands /
              // #__denext_state islands (computed once all holes resolve) hydrate the
              // client boundaries. Carries the same strict streaming CSP.
              if (
                config.streaming !== false && !soft && !willIsrCache && useFlight &&
                request.method === "GET"
              ) {
                const shellResult = await renderPageFlightShell(
                  page,
                  request,
                  pageLoad,
                  {
                    flight: true,
                    messages,
                    signal: requestCtx.signal,
                    onCaughtError: (e) => boundaryErrors.push(e),
                  },
                  prepared,
                );
                for (const be of boundaryErrors) {
                  await reportRequestError(config, be, request, page.route.routePath, {
                    routeType: "render",
                    renderSource: "react-server-components",
                  });
                }
                augmentMetadata(shellResult.metadata); // og:image + icon conventions
                const clientEntry = config.clientEntryFor?.(page.route);
                const streamStyles = config.styleHrefsFor?.(page.route);
                const streamHydration: HydrationData | undefined = clientEntry
                  ? {
                    params: page.params,
                    searchParams: url.searchParams.toString(),
                    pathname,
                    messages,
                    basePath: basePath || undefined,
                  }
                  : undefined;
                const docOpts = {
                  metadata: shellResult.metadata,
                  viewport: shellResult.viewport,
                  hydration: streamHydration,
                  clientEntry,
                  styles: streamStyles,
                  devScript: config.devScript,
                  devScriptSrc: config.devScriptSrc,
                  lang: locale || undefined,
                  publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
                };
                const streamHeaders = { "cache-control": "private, no-store" };
                // Only stream when the Flight shell has deferred holes; a hole-less
                // client-island page is served buffered (parity with the non-Flight
                // branch) so a fully-static Flight route stays CDN-cacheable instead of
                // being forced no-store, and no useless swap runtime is emitted.
                if (shellResult.flightShell && shellResult.flightShell.hasHoles) {
                  // Dev render-mode telemetry: this response streams (Suspense holes).
                  requestCtx.renderStreamed = true;
                  const stream = streamFlightDocument({
                    ...docOpts,
                    flightShell: shellResult.flightShell,
                    signal: requestCtx.signal,
                  });
                  const shellPrefix =
                    renderHeadContent(shellResult.metadata, shellResult.viewport, streamStyles) +
                    shellResult.flightShell.shellHtml;
                  const csp = await resolveStreamingCsp(
                    shellPrefix,
                    prepared.config.csp,
                    config.csp,
                  );
                  return finalize(
                    new Response(stream, {
                      status: 200,
                      headers: htmlHeaders(csp, streamHeaders),
                    }),
                  );
                }
                if (shellResult.flightShell) {
                  // No holes: drain the tail (nothing is enqueued) and serve a complete
                  // buffered Flight document — identical to the buffered Flight path.
                  const sink = {
                    enqueue() {},
                  } as unknown as ReadableStreamDefaultController<Uint8Array>;
                  const tail = await shellResult.flightShell.streamHoles(
                    sink,
                    new TextEncoder(),
                    requestCtx.signal,
                  );
                  const doc = renderDocument({
                    ...docOpts,
                    bodyHtml: shellResult.flightShell.shellHtml,
                    flight: tail.flight,
                    islands: tail.islands,
                    signalState: tail.signalState,
                  });
                  const csp = await resolveCsp(doc, prepared.config.csp, config.csp);
                  const dynamic = requestCtx.usedDynamicApi === true;
                  const bufHeaders = dynamic
                    ? { "cache-control": "private, no-store", vary: "x-denext-nav, Cookie" }
                    : undefined;
                  return finalize(
                    new Response(doc, { status: 200, headers: htmlHeaders(csp, bufHeaders) }),
                  );
                }
                // A control signal fired in the shell → a buffered signal-UI page.
                const doc = renderDocument({ ...docOpts, bodyHtml: shellResult.html ?? "" });
                const docCsp = await resolveCsp(doc, prepared.config.csp, config.csp);
                return finalize(
                  new Response(doc, {
                    status: shellResult.status,
                    headers: htmlHeaders(docCsp, streamHeaders),
                  }),
                );
              }

              rendered = await renderPage(page, request, pageLoad, {
                flight: useFlight,
                messages,
                signal: requestCtx.signal,
                onCaughtError: (e) => boundaryErrors.push(e),
              }, prepared);
            } catch (pageError) {
              // A cooperative abort (client disconnect / timeout) is not an app
              // error — let it unwind to the top-level handler, no global-error.
              if (isAbortError(pageError)) throw pageError;
              // redirect() from a server component issues an HTTP redirect.
              if (isRedirect(pageError)) {
                return finalize(
                  new Response(null, {
                    status: pageError.status,
                    headers: { location: safeRedirectLocation(pageError.url) },
                  }),
                );
              }
              // A global-error.tsx replaces the whole tree on an uncaught error.
              const ge = await renderGlobalError(
                manifest,
                config.load,
                pageError,
              );
              if (!ge) throw pageError; // re-thrown: the top-level catch reports it
              // Handled here (global-error rendered), so report it now — the
              // top-level catch won't see it.
              await reportRequestError(
                config,
                pageError,
                request,
                page.route.routePath,
                {
                  routeType: "render",
                  renderSource: useFlight ? "react-server-components" : "server-rendering",
                },
              );
              rendered = ge;
            }
            // Report boundary-caught errors to onRequestError (routeType "render").
            // The render already succeeded; H1 logged the real error server-side —
            // this surfaces it to instrumentation too (M4).
            for (const be of boundaryErrors) {
              await reportRequestError(
                config,
                be,
                request,
                page.route.routePath,
                {
                  routeType: "render",
                  renderSource: useFlight ? "react-server-components" : "server-rendering",
                },
              );
            }
            const { html, metadata, status } = rendered;
            augmentMetadata(metadata);
            // Flight soft-navigation: a client nav (x-denext-nav) to a Flight
            // route gets the JSON Flight payload instead of a full HTML document
            // — the client parses it through the app-wide client registry and
            // reconciles the retained root in place (no HTML parse, no bundle
            // re-run). Falls through to the HTML path when there is no Flight
            // payload (e.g. a 404 / global-error render), which the client
            // handles as an ordinary HTML soft-nav. Never cached (soft) and
            // marked no-store so a shared CDN can't serve it to a hard request.
            if (
              soft && useFlight && rendered.flight !== undefined &&
              request.method === "GET"
            ) {
              const payload = serializeFlightNav({
                flight: rendered.flight,
                title: typeof metadata.title === "string" ? metadata.title : undefined,
                data: {
                  params: page.params,
                  searchParams: url.searchParams.toString(),
                  pathname,
                  messages,
                  basePath: basePath || undefined,
                },
                // Carry lazy islands + signal state so a soft nav can render/wire
                // them (the route Flight has them only as empty foreign hosts).
                islands: rendered.islands,
                signalState: rendered.signalState,
              });
              return finalize(
                new Response(payload, {
                  status,
                  headers: {
                    "content-type": "application/json; charset=utf-8",
                    "x-denext-flight": "1",
                    "cache-control": "private, no-store",
                    // L9: this URL yields Flight JSON to a soft nav but full HTML to
                    // a hard request — key any intermediary cache on the nav header
                    // (belt-and-suspenders atop no-store) so the variants never cross.
                    "vary": "x-denext-nav",
                  },
                }),
              );
            }

            // Isomorphic soft-navigation: a route WITH a client entry but no Flight
            // boundary re-renders from its re-run bundle on a soft nav, so the SSR
            // <body> is discarded by the client. Send only what it uses — title,
            // hydration data, the route's stylesheet hrefs, and the entry src — as a
            // compact JSON payload instead of the full HTML document. Never cached
            // (soft) and no-store, keyed on the nav header like the Flight variant.
            const isoEntry = soft && !useFlight && request.method === "GET"
              ? config.clientEntryFor?.(page.route)
              : undefined;
            if (isoEntry) {
              const payload: IsoNavPayload = {
                title: typeof metadata.title === "string" ? metadata.title : undefined,
                data: {
                  params: page.params,
                  searchParams: url.searchParams.toString(),
                  pathname,
                  messages,
                  basePath: basePath || undefined,
                },
                entry: isoEntry,
                styles: config.styleHrefsFor?.(page.route),
              };
              return finalize(
                new Response(JSON.stringify(payload), {
                  status,
                  headers: {
                    "content-type": "application/json; charset=utf-8",
                    "x-denext-iso": "1",
                    "cache-control": "private, no-store",
                    "vary": "x-denext-nav",
                  },
                }),
              );
            }

            // <html lang>: the active locale (i18n) or the framework default.
            const lang = locale || undefined;
            // Public (client-exposable) env for the hydration island.
            const pubEnv = restrictPublicEnv(publicEnv(), config.publicEnvKeys);

            // ISR: cache the rendered document when the config opts in — but
            // never when the render read a dynamic API (cookies()/headers()),
            // which implies per-request output that must not be shared.
            if (cacheable && status === 200 && !requestCtx.usedDynamicApi) {
              const timing = pageCacheTiming(rendered.config);
              if (timing !== null) {
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
                  devScriptSrc: config.devScriptSrc,
                  flight: rendered.flight,
                  viewport: rendered.viewport,
                  lang,
                  publicEnv: pubEnv,
                });
                // Hash-based CSP: computed from the exact cached bytes, so it
                // stays valid on every future cache hit. Stored alongside the body.
                const csp = await resolveCsp(
                  cachedDoc,
                  rendered.config.csp,
                  config.csp,
                );
                if (config.cacheKeyParams) {
                  warnUnkeyedParamReads(requestCtx, config.cacheKeyParams);
                }
                // Inherit the tags of any cached data this render read, so
                // revalidateTag(tag) purges the page too — not just the data.
                await config.pageCache!.set(cacheKey, {
                  body: cachedDoc,
                  status,
                  path: pathname,
                  expiresAt: timing.expiresAt,
                  staleAt: timing.staleAt,
                  tags: requestCtx.collectedTags ? [...requestCtx.collectedTags] : [],
                  csp,
                });
                return finalize(
                  new Response(cachedDoc, {
                    status,
                    headers: htmlHeaders(csp, { "x-denext-cache": "MISS" }),
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
              devScriptSrc: config.devScriptSrc,
              flight: rendered.flight,
              islands: rendered.islands,
              signalState: rendered.signalState,
              viewport: rendered.viewport,
              lang,
              publicEnv: pubEnv,
            });

            const csp = await resolveCsp(doc, rendered.config.csp, config.csp);
            // Two per-request response shapes must never be stored by a shared cache
            // and served to another visitor:
            //  - a soft-nav (prefetch) variant (cf. CVE-2023-46298), and
            //  - a DYNAMIC render that read cookies()/headers() — it is per-user, so
            //    it needs `no-store` + `Vary: Cookie` (M1). denext never stores such a
            //    render in its own ISR cache; this guards an upstream CDN too.
            const dynamic = requestCtx.usedDynamicApi === true;
            const navHeaders = (soft || dynamic)
              ? {
                "cache-control": "private, no-store",
                ...(dynamic ? { vary: "x-denext-nav, Cookie" } : {}),
              }
              : undefined;
            if (request.method === "HEAD") {
              return finalize(
                new Response(null, {
                  status,
                  headers: htmlHeaders(csp, navHeaders),
                }),
              );
            }
            return finalize(
              new Response(doc, {
                status,
                headers: htmlHeaders(csp, navHeaders),
              }),
            );
          }
        }

        // 2b. A real page URL reached by a method other than GET/HEAD is a 405, not
        // a 404 — the resource exists, the method doesn't. Server Actions (POST
        // /_denext/action/*) and API routes are already handled above, so this only
        // catches a stray POST/PUT/DELETE/… to an actual page path.
        if (request.method !== "GET" && request.method !== "HEAD") {
          if (matchPage(manifest, routingPath, { soft: false })) {
            return finalize(
              new Response("Method Not Allowed", {
                status: 405,
                headers: { allow: "GET, HEAD" },
              }),
            );
          }
        }

        // 2c. Plugin claim-hook (e.g. a Pages Router). Runs after App-Router page/
        // API matching so core routes always win; before static assets + 404. The
        // plugin owns method handling for the routes it claims.
        if (config.matchExternal) {
          const claimed = await config.matchExternal(request);
          if (claimed) return finalize(claimed);
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
            devScriptSrc: config.devScriptSrc,
            lang: config.i18n?.defaultLocale,
            publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
          });
          const csp = await resolveCsp(doc, undefined, config.csp);
          if (request.method === "HEAD") {
            return finalize(
              new Response(null, { status, headers: htmlHeaders(csp) }),
            );
          }
          return finalize(
            new Response(doc, { status, headers: htmlHeaders(csp) }),
          );
        }
        return finalize(notFound(pathname));
      } catch (error) {
        // A cooperative abort (client disconnect / request timeout) is not a
        // server error: don't log it or run onError. The client is gone, or the
        // timeout race has already sent the 503; this response is discarded.
        if (isAbortError(error) || requestCtx.signal?.aborted) {
          return new Response(null, { status: 503 });
        }
        // Report to instrumentation before rendering the error response.
        await reportRequestError(config, error, request, pathname, {
          routeType: dispatchRouteType,
          renderSource: dispatchRouteType === "render" ? "server-rendering" : undefined,
        });
        // A throwing custom error renderer must not escape — fall back to the 500.
        if (config.onError) {
          try {
            return await config.onError(error, request);
          } catch (onErrorFailure) {
            console.error(
              "denext: onError handler threw",
              requestCtx.requestId,
              pathname,
              onErrorFailure,
            );
          }
        }
        console.error(
          "denext: unhandled error while handling",
          requestCtx.requestId,
          pathname,
          error,
        );
        return new Response("Internal Server Error", {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-request-id": requestCtx.requestId,
          },
        });
      } finally {
        // Drain after() callbacks (and deferred cache invalidations) WITHOUT
        // blocking the response — after() must not delay it. runDeferred swallows
        // every error, so the detached promise can never reject. (On a serverless
        // runtime that freezes the isolate the instant the response is sent, this
        // work is best-effort — the same caveat as the platform's own after().)
        void runDeferred(requestCtx);
        // Release any ISR single-flight followers waiting on this key (the cache
        // is populated by now if the render was cacheable).
        if (releasePageLeader) releasePageLeader();
      }
    });

    // Per-request timeout: race the pipeline against a deadline → 503. Defaults to
    // 30s so a runaway or wedged render/action can't pin resources; the render is
    // signal-aware, so the abort actually reclaims the work. `requestTimeout: 0`
    // disables. `isBackgroundRegen` is computed at the top of handle.
    const requestTimeout = isBackgroundRegen
      ? 0
      : (config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT);
    if (requestTimeout > 0) {
      pipeline = withRequestTimeout(pipeline, requestTimeout, controller);
    }
    // Echo the correlation id on every error response (M5) — the global-error 500,
    // the timeout 503, and the abort 503, matching the fallback 500 and the
    // documented contract. Added after the timeout wrap so the 503 it produces is
    // covered too. (The pre-context shed 503 has no id yet and is left as-is.)
    pipeline = pipeline.then((res) => {
      if (res.status >= 500 && !res.headers.has("x-request-id")) {
        try {
          res.headers.set("x-request-id", requestCtx.requestId);
        } catch { /* immutable headers (rare) — leave as-is */ }
      }
      return res;
    });
    // Default hardening headers on every response (added only where the app has
    // not set its own via headers()/middleware). Covers page/redirect/error paths
    // that bypass finalize(). `x-forwarded-proto` is only consulted behind a
    // trusted proxy (config.trustForwardedHeaders) — otherwise a client could spoof
    // it — falling back to the connection's own protocol. A proxy may emit a
    // comma-separated chain ("https, http"); the first hop is the client scheme.
    const forwardedProto = config.trustForwardedHeaders
      ? originalRequest.headers.get("x-forwarded-proto")?.split(",")[0].trim()
        .toLowerCase()
      : undefined;
    const secure = forwardedProto === "https" ||
      new URL(originalRequest.url).protocol === "https:";
    pipeline = pipeline.then((res) => applyDefaultSecurityHeaders(res, secure, config.hsts));

    // Observability: emit timing + final status after the response resolves.
    const logRequest = config.onRequest ??
      (REQUEST_LOG_ENABLED ? defaultRequestLog : undefined);
    if (logRequest) {
      pipeline = pipeline.then((res) => {
        try {
          logRequest({
            method: originalRequest.method,
            path: new URL(originalRequest.url).pathname,
            status: res.status,
            durationMs: performance.now() - startedAt,
            requestId: requestCtx.requestId,
          });
        } catch { /* observability must never break the response */ }
        return res;
      });
    }
    // Release the concurrency slot once the response is produced, on every exit path
    // (success, error, abort, timeout — all settle the pipeline). For a streaming
    // body this is when the Response is returned, not when the body finishes: the
    // ceiling bounds handler/render concurrency up to Response production, and the
    // client-read duration of a stream is bounded at the edge (see maxConcurrency
    // docs) — holding the slot for the whole download would invite a slowloris-read
    // slot exhaustion and would starve long-lived SSE under the ceiling.
    if (maxConcurrency > 0 && !isBackgroundRegen) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlight--;
      };
      if (requestTimeout === 0) {
        // No request deadline: a render that never settles would otherwise never
        // release its slot. A backstop timer frees the slot (only the counter, not
        // the render) so the ceiling can never permanently wedge. Unref'd so it
        // can't by itself keep the process alive; cleared on the normal exit.
        const backstop = setTimeout(
          release,
          config.slotBackstop ?? DEFAULT_SLOT_BACKSTOP,
        );
        Deno.unrefTimer(backstop);
        pipeline = pipeline.finally(() => {
          clearTimeout(backstop);
          release();
        });
      } else {
        pipeline = pipeline.finally(release);
      }
    }
    return pipeline;
  };
}

/** Abort `controller` when `source` aborts (client disconnect), if present. */
function linkAbort(
  source: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (!source) return;
  if (source.aborted) {
    controller.abort();
    return;
  }
  source.addEventListener("abort", () => controller.abort(), { once: true });
}

/** Headers for an HTML document response: content-type + optional CSP + extras. */
function htmlHeaders(
  csp?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  if (csp) headers["content-security-policy"] = csp;
  // L9: a page URL yields full HTML to a hard request but a Flight/soft variant to
  // a soft nav (x-denext-nav). Key any intermediary cache on that header so a
  // cached hard-nav document is never served to a soft nav (belt-and-suspenders).
  headers["vary"] = "x-denext-nav";
  return extra ? { ...headers, ...extra } : headers;
}

/**
 * Build the `Strict-Transport-Security` header value from {@link HstsConfig}
 * (`false` ⇒ omit the header). Default: `max-age=31536000` (host-only). Adds
 * `includeSubDomains`/`preload` only when configured (`preload` implies
 * `includeSubDomains`, per the preload-list rules).
 */
export function hstsHeaderValue(hsts?: HstsConfig | false): string | null {
  if (hsts === false) return null;
  const maxAge = hsts?.maxAge ?? 31536000;
  let value = `max-age=${maxAge}`;
  if (hsts?.includeSubDomains || hsts?.preload) value += "; includeSubDomains";
  if (hsts?.preload) value += "; preload";
  return value;
}

/**
 * Add opinionated hardening headers to a response, but never override one the app
 * already set (via `headers()` or middleware). `X-Content-Type-Options`,
 * `X-Frame-Options`, and `Referrer-Policy` are always applied; HSTS only when the
 * request arrived over HTTPS (harmless, but avoids pinning a plain-HTTP dev host)
 * and not disabled via `hsts: false`.
 *
 * @param hsts Optional HSTS tuning (from `denext.config`); omitted ⇒ the default policy.
 */
export function applyDefaultSecurityHeaders(
  res: Response,
  secure: boolean,
  hsts?: HstsConfig | false,
): Response {
  const defaults: Array<[string, string]> = [
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "SAMEORIGIN"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
  ];
  const hstsValue = secure ? hstsHeaderValue(hsts) : null;
  if (hstsValue) defaults.push(["strict-transport-security", hstsValue]);
  try {
    // Fast path: mutate in place when the Headers object is mutable.
    for (const [name, value] of defaults) {
      if (!res.headers.has(name)) res.headers.set(name, value);
    }
    return res;
  } catch {
    // Immutable headers (e.g. a Response.redirect() from a route handler): rebuild.
    const headers = new Headers(res.headers);
    for (const [name, value] of defaults) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/** Race a response against a timeout; on expiry, abort in-flight work and 503. */
function withRequestTimeout(
  pipeline: Promise<Response>,
  ms: number,
  controller: AbortController,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(
        new Response("Service Unavailable (request timeout)", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }, ms);
  });
  return Promise.race([pipeline, timeout]).finally(() => clearTimeout(timer));
}

/** The `DENEXT_LOG` value ("", "1", "json", …), or "" when unset/unreadable. */
const REQUEST_LOG_MODE = (() => {
  try {
    return Deno.env.get("DENEXT_LOG") ?? "";
  } catch {
    return ""; // env not permitted; stay silent
  }
})();

/** Whether the default request logger is enabled at all (`DENEXT_LOG` set). */
const REQUEST_LOG_ENABLED = REQUEST_LOG_MODE !== "";
/** Whether to emit structured JSON (`DENEXT_LOG=json`) vs. the compact human line. */
const REQUEST_LOG_JSON = REQUEST_LOG_MODE.toLowerCase() === "json";

function defaultRequestLog(info: RequestLogInfo): void {
  // `DENEXT_LOG=json` emits one structured JSON object per request (ingestible by a
  // log pipeline); any other truthy value emits the compact human-readable line.
  if (REQUEST_LOG_JSON) {
    console.log(JSON.stringify({
      level: "info",
      msg: "request",
      method: info.method,
      path: info.path,
      status: info.status,
      statusClass: `${Math.floor(info.status / 100)}xx`,
      durationMs: Number(info.durationMs.toFixed(1)),
      requestId: info.requestId,
    }));
    return;
  }
  console.log(
    `[denext] ${info.method} ${info.path} ${info.status} ` +
      `${info.durationMs.toFixed(1)}ms ${info.requestId}`,
  );
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
  info: {
    routeType?: RequestErrorContext["routeType"];
    renderSource?: RequestErrorContext["renderSource"];
    revalidateReason?: RequestErrorContext["revalidateReason"];
    renderType?: RequestErrorContext["renderType"];
  } = {},
): Promise<void> {
  if (!config.onRequestError) return;
  try {
    // Next passes a plain `{ path, method, headers }` object (not a `Request`), so
    // instrumentation reading `request.path`/`.method` (Sentry/otel) works unchanged.
    const url = new URL(request.url);
    const nextRequest = {
      path: url.pathname + url.search,
      method: request.method,
      headers: Object.fromEntries(request.headers) as Record<
        string,
        string | string[]
      >,
    };
    await config.onRequestError(error, nextRequest, {
      routerKind: "App Router",
      routePath,
      routeType: info.routeType ?? "render",
      renderSource: info.renderSource,
      // Default: an error during a background ISR regeneration is "stale".
      revalidateReason: info.revalidateReason ??
        (request.headers.get(REGEN_HEADER) === REGEN_TOKEN ? "stale" : undefined),
      renderType: info.renderType ?? "dynamic",
    });
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
      tagClientExports(
        mod as Record<string, unknown>,
        clientIdFor(appDir, toFileUrl(path).href),
      );
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
