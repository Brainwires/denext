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
export type { AppConfig, RequestHandler } from "./app.ts";
export { renderPage } from "./render-page.ts";
export type { RenderedPage, RenderPageOptions } from "./render-page.ts";
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
export type { Directive } from "../build/directives.ts";
export { matchSlot } from "../router/match.ts";
export type { ApiMatch, MatchOptions, PageMatch } from "../router/match.ts";
export type { Intercept, RouteParams, Segment, SegmentKind } from "../router/segments.ts";
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
  NEXT,
  next,
  redirect,
  REWRITE,
  rewrite,
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
  Revalidate,
  RouteDynamic,
  SegmentConfig,
  SegmentConfigExports,
} from "./segment-config.ts";

// Per-request async context — cookies()/headers()/draftMode() for server code.
export {
  cookies,
  currentContext,
  draftMode,
  headers,
  setDraftTokenStore,
} from "./request-context.ts";
export type {
  CookieSetOptions,
  CookieStore,
  DraftMode,
  DraftTokenStore,
  RequestContext,
} from "./request-context.ts";

// Absolute-URL helpers (public origin behind reverse proxies).
export { absoluteUrl, type OriginOptions, requestOrigin } from "./absolute-url.ts";

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
  PageCache,
  revalidatePath,
  revalidateTag,
  unstable_cache,
} from "./cache.ts";
export type { CachedPage, CacheOptions } from "./cache.ts";

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

// Metadata file conventions (sitemap.ts / robots.ts / manifest.ts / favicon.ico).
export {
  OPENGRAPH_IMAGE_PATH,
  serializeRobots,
  serializeSitemap,
  serializeSvg,
  serveMetadataFile,
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
  const handler: RequestHandler = createApp({
    getManifest: options.getManifest,
    load: options.load ?? defaultLoader,
    publicDir: options.publicDir,
    clientEntryFor: options.clientEntryFor,
    getMiddleware: options.getMiddleware,
    devScript: options.devScript,
    onError: options.onError,
    i18n: options.i18n,
    pageCache: options.pageCache,
    allowedOrigins: options.allowedOrigins,
    flight: options.flight,
    appDir: options.appDir,
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
