// The app-level configuration (`AppConfig`) createApp is built from, the request-handler
// contract, the per-process constants the pipeline stages share, and the instrumentation
// bridge (`reportRequestError`). Imported by every pipeline module; imports none of them.

import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import type { ModuleLoader } from "./types.ts";
import type { MiddlewareRunner } from "./middleware.ts";
import type { I18nConfig } from "./i18n.ts";
import type { HeaderRule, HstsConfig, RedirectRule, RewriteRule } from "./config.ts";
import type { PageCache } from "./cache.ts";
import type { CspSetting } from "./csp.ts";
import type { OnRequestError, RequestErrorContext } from "./instrumentation.ts";

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
   * server action that hangs (e.g. a request-driven unbounded loop). The deadline stays
   * armed across a streamed body (a hole that never settles ends the stream with its
   * fallback in place). **Default: 30 000 ms**; `0` disables it (a slow request body is
   * always bounded separately).
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

/** Default per-request deadline (ms). Bounds a runaway/wedged render or action. */
export const DEFAULT_REQUEST_TIMEOUT = 30_000;

/**
 * Per-process unguessable marker for the in-process ISR background-regen loopback.
 * A background regen is exempt from the concurrency ceiling, the request timeout,
 * the ISR cache read, and stampede single-flight — so the marker MUST NOT be
 * client-forgeable. It lives only in this process and is set on the internal
 * loopback request (never sent over the wire); an external `x-denext-regen` header
 * carries some other value and is therefore ignored (H2).
 */
export const REGEN_TOKEN: string = crypto.randomUUID();
/** Header carrying {@link REGEN_TOKEN} on the internal regen loopback. */
export const REGEN_HEADER = "x-denext-regen";

/**
 * Default backstop (ms) that force-frees a held concurrency slot when the request
 * timeout is disabled. It never aborts the render — it only releases the counter so a
 * never-settling request can't permanently wedge the concurrency ceiling into 503s.
 */
export const DEFAULT_SLOT_BACKSTOP = 120_000;

/** Whether `request` is the in-process ISR background-regeneration loopback. */
export function isRegenRequest(request: Request): boolean {
  return request.headers.get(REGEN_HEADER) === REGEN_TOKEN;
}

/** The GET/HEAD methods a page or metadata file is served for. */
export function isReadMethod(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

/** The trusted-origin options `requestOrigin`/`absoluteUrl` take, from the app config. */
export function originOptions(
  config: AppConfig,
): { canonicalOrigin?: string; trustForwardedHeaders?: boolean } {
  return {
    canonicalOrigin: config.canonicalOrigin,
    trustForwardedHeaders: config.trustForwardedHeaders,
  };
}

/**
 * Invoke the configured `onRequestError` hook defensively: a throw from
 * instrumentation is logged, never propagated (it must not mask the original
 * error or take down the response).
 */
export async function reportRequestError(
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
