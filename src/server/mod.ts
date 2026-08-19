/**
 * Public server entrypoint for the denext framework.
 *
 * Provides the primitives for building and running a denext app on the server:
 * {@linkcode createApp}/{@linkcode serve} to turn a route manifest into an HTTP
 * request handler, page and document rendering ({@linkcode renderPage},
 * {@linkcode renderDocument}), API dispatch ({@linkcode handleApi}), static file
 * serving ({@linkcode serveStatic}), root middleware helpers, and the shared
 * types describing page, layout, and API route modules.
 *
 * @module
 */

// Server public surface: create/serve a denext app.

import { toFileUrl } from "@std/path";
import { type AppConfig, createApp, type RequestHandler } from "./app.ts";
import type { ModuleLoader } from "./types.ts";
import { serveWithPortFallback } from "./serve-utils.ts";

export { createApp } from "./app.ts";
export type { AppConfig, RequestHandler, RequestLogInfo } from "./app.ts";
export { renderPage } from "./render-page.ts";
export type { PageContext, RenderedPage, RenderPageOptions } from "./render-page.ts";
// Flight (RSC) types, referenced by RenderedPage/DocumentOptions.
export type {
  FlightActionRef,
  FlightClient,
  FlightDate,
  FlightHost,
  FlightNode,
  FlightPrimitive,
  FlightProps,
  FlightValue,
} from "../jsx/render-to-flight.ts";
export { renderToFlight } from "../jsx/render-to-flight.ts";
export { renderToHtmlFlight, serializeFlight } from "../jsx/render-to-html-flight.ts";
export type { HtmlFlight, HtmlFlightOptions } from "../jsx/render-to-html-flight.ts";
export { renderToFlightStream } from "../jsx/render-to-flight-stream.ts";
export type { FlightStreamOptions } from "../jsx/render-to-flight-stream.ts";
export type { HeadCollector } from "../jsx/render-to-string.ts";
export { renderDocument, ROOT_ID } from "./document.ts";
export type { DocumentOptions, HydrationData } from "./document.ts";
export { serveStatic } from "./static.ts";
export { serveWithPortFallback } from "./serve-utils.ts";
export type { ServeUtilOptions } from "./serve-utils.ts";
export { handleApi } from "./api.ts";
export type * from "./types.ts";

// Re-export the router and JSX types referenced by the public API so that they
// are documented as part of this entrypoint (type-only, no runtime effect).
export type { ApiRoute, PageRoute, RouteManifest, SlotRoutes } from "../router/manifest.ts";
// Plugin contract (Workstream C): the semver-stable surface a plugin (e.g. a Pages
// Router) extends. `RouteSynthesizer` + the route/convention registrars are the
// route seam; the plugin types + registrars below are the request/build seams.
export type { RouteSynthesizer } from "../router/manifest.ts";
export { registerConvention, registerRouteSynthesizer, scanRoutes } from "../router/manifest.ts";
export type {
  DenextPlugin,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginRequestHandler,
  PluginTeardown,
} from "../plugin/mod.ts";
export type { Directive } from "../build/directives.ts";
export { matchSlot } from "../router/match.ts";
export type { ApiMatch, MatchOptions, PageMatch } from "../router/match.ts";
export type { Intercept, RouteParams, Segment, SegmentKind } from "../router/segments.ts";
// Segment parser + matcher primitives — the reusable core of the router, exposed
// so a routing plugin (e.g. a Pages Router) can parse patterns and match paths.
export {
  matchSegments,
  parsePattern,
  parseSegment,
  specificity,
  splitPath,
} from "../router/segments.ts";
export type {
  Component,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../jsx/types.ts";
// FRAGMENT is referenced by VNodeType (`typeof FRAGMENT`); re-export it so that
// type stays public. This only widens the type surface, not runtime behavior.
export { FRAGMENT } from "../jsx/types.ts";

export {
  composeMiddleware,
  createMiddlewareRunner,
  matcherToRegExp,
  matches,
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_OVERRIDE_HEADER,
  MIDDLEWARE_REQUEST_PREFIX,
  MIDDLEWARE_REWRITE_HEADER,
  NEXT,
  next,
  redirect,
  REWRITE,
  rewrite,
  setRequestAdapter,
  withHeaders,
} from "./middleware.ts";
export type {
  Middleware,
  MiddlewareConfig,
  MiddlewareContext,
  MiddlewareEntry,
  MiddlewareExport,
  MiddlewareModule,
  MiddlewareOutcome,
  MiddlewareResult,
  MiddlewareRunner,
  NextCommand,
  RewriteCommand,
} from "./middleware.ts";

// Project configuration (denext.config): redirects / rewrites / headers / etc.
export {
  type CompiledPattern,
  compilePattern,
  type DenextConfig,
  type ExperimentalConfig,
  fillDestination,
  type HeaderRule,
  type HstsConfig,
  type ImagesConfig,
  type LocalPattern,
  matchPattern,
  type RedirectRule,
  type RemotePattern,
  resolveConfigRules,
  type ResolvedRules,
  type RewriteRule,
  safeRedirectLocation,
  type TailwindConfig,
} from "./config.ts";

// Internationalized routing (optional default-locale prefix).
export {
  detectLocale,
  localeMiddleware,
  parseAcceptLanguage,
  peelLocale,
  resolveMessages,
} from "./i18n.ts";
export type { I18nConfig, PeeledLocale } from "./i18n.ts";
// i18n message catalog primitives (also power useTranslations() on the client).
export {
  interpolate,
  makeTranslate,
  type Messages,
  provideMessages,
  type TranslateFn,
  type TranslationVars,
} from "../runtime/i18n-messages.ts";

// Route segment config (export const dynamic/revalidate/dynamicParams/…).
export { DEFAULT_SEGMENT_CONFIG, mergeSegmentConfig, readSegmentConfig } from "./segment-config.ts";
export type {
  CspSetting,
  Revalidate,
  RouteCsp,
  RouteDynamic,
  SegmentConfig,
  SegmentConfigExports,
} from "./segment-config.ts";

// Per-request async context — cookies()/headers()/draftMode()/after() for server code.
export {
  after,
  connection,
  cookies,
  currentContext,
  draftMode,
  headers,
  setDraftTokenStore,
} from "./request-context.ts";
// User-Agent parsing (userAgent(request)).
export { type UserAgent, userAgent } from "./user-agent.ts";
export type {
  CookieSetOptions,
  CookieStore,
  DraftMode,
  DraftTokenStore,
  RequestContext,
} from "./request-context.ts";

// Signed-cookie sessions (auth primitive).
export { getSession } from "./session.ts";
export type { Session, SessionOptions } from "./session.ts";

// Absolute-URL helpers (public origin behind reverse proxies).
export { absoluteUrl, type OriginOptions, requestOrigin } from "./absolute-url.ts";

// Instrumentation (instrumentation.ts): register() + onRequestError().
export {
  type Instrumentation,
  loadInstrumentation,
  runRegister,
  setNextRuntimeEnv,
} from "./instrumentation.ts";
export type {
  InstrumentationRequest,
  OnRequestError,
  RegisterFn,
  RequestErrorContext,
} from "./instrumentation.ts";

// Environment: .env loading + the client/server public-env isolation boundary.
export {
  filterPublicEnv,
  isPublicEnvKey,
  loadEnv,
  type LoadEnvOptions,
  parseEnv,
  PUBLIC_ENV_ID,
  PUBLIC_ENV_PREFIXES,
  publicEnv,
  publicEnvFrom,
} from "./env.ts";

// Data cache, request memoization, and ISR.
export {
  cache,
  cachedFetch,
  cacheLife,
  cacheTag,
  inMemoryCacheStore,
  PageCache,
  refresh,
  registerCacheLifeProfiles,
  resolveCacheLife,
  revalidatePath,
  revalidateTag,
  setCacheStore,
  unstable_cache,
  updateTag,
} from "./cache.ts";
export type {
  CachedPage,
  CacheEntryTiming,
  CacheLifeProfile,
  CacheOptions,
  CacheStore,
  DataEntry,
} from "./cache.ts";

// Durable single-node CacheStore: a local SQLite file via the first-party
// @denext/sqlite codec (zero npm) — the recommended persistent store, and needs no
// unstable runtime flag.
export { sqliteCacheStore } from "./sqlite-cache.ts";
export type { SqliteCacheStoreOptions } from "./sqlite-cache.ts";

// Shared-cache backend: a Deno KV-backed CacheStore for multi-replica ISR.
export { denoKvCacheStore } from "./kv-cache.ts";

// Server Actions — runtime registration + secure same-origin dispatch.
export {
  actionEndpoint,
  clientActionStub,
  decodeActionArgs,
  getServerAction,
  isServerAction,
  registerServerReference,
  serverAction,
  tagServerExports,
  tagServerModules,
} from "../runtime/server-action.ts";
export type { ServerActionRef } from "../runtime/server-action.ts";
export { handleAction, isActionRequest } from "./action-handler.ts";
export type { ActionHandlerOptions } from "./action-handler.ts";

// Dynamic OG images: render JSX to a PNG (next/og-style ImageResponse).
export { ImageResponse, type ImageResponseOptions } from "./image-response.ts";
// Self-hosted image optimization endpoint (backs <Image loader={denextImageLoader}>).
export { type ImageOptimizeOptions, optimizeImage } from "./image-optimizer.ts";
export {
  safeFetch,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
} from "./safe-fetch.ts";

// Metadata file conventions (sitemap.ts / robots.ts / manifest.ts / favicon.ico).
export {
  APPLE_ICON_PATH,
  ICON_PATH,
  OPENGRAPH_IMAGE_PATH,
  serializeRobots,
  serializeSitemap,
  serializeSvg,
  serveMetadataFile,
  TWITTER_IMAGE_PATH,
} from "./metadata-files.ts";
export type {
  OpenGraphImageResult,
  Robots,
  RobotsRule,
  Sitemap,
  SitemapEntry,
} from "./metadata-files.ts";

/** Default module loader: dynamic import by absolute file path. */
export const defaultLoader: ModuleLoader = (filePath): Promise<unknown> => {
  const url = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
  return import(url);
};

/** Options for {@linkcode serve}: app configuration plus HTTP listen settings. */
export interface ServeOptions extends Partial<AppConfig> {
  /** Resolve the route manifest to serve (required). */
  getManifest: AppConfig["getManifest"];
  /** Port to listen on; defaults to 3000. */
  port?: number;
  /** Hostname/interface to bind; defaults to "0.0.0.0". */
  hostname?: string;
  /** Signal used to shut the server down. */
  signal?: AbortSignal;
  /** Called once the server is listening, with the bound host and port. */
  onListen?: (info: { hostname: string; port: number }) => void;
}

/** Create an app and serve it over HTTP via Deno.serve. */
export function serve(options: ServeOptions): Deno.HttpServer {
  // Forward EVERY AppConfig field the caller set — previously this hand-picked a
  // subset and silently dropped actionMaxBodyBytes, canonicalOrigin,
  // trustForwardedHeaders, basePath, redirects, rewrites, headerRules,
  // trailingSlash, … so an embedder couldn't configure the body limit or proxy
  // trust. The serve-only fields (port/hostname/signal/onListen) are ignored by
  // createApp.
  const handler: RequestHandler = createApp({
    ...options,
    load: options.load ?? defaultLoader,
  });

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "0.0.0.0",
      signal: options.signal,
      onListen: options.onListen ??
        (({ hostname, port }) => console.log(`denext listening on http://${hostname}:${port}`)),
    },
    handler,
  );
}
