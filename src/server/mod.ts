/**
 * Public server entrypoint for the denext framework.
 *
 * Provides the primitives for building and running a denext app on the server:
 * {@linkcode createApp}/{@linkcode serve} to turn a route manifest into an HTTP
 * request handler, page and document rendering ({@linkcode renderPage},
 * {@linkcode renderDocument}), static file
 * serving ({@linkcode serveStatic}), root middleware helpers, and the shared
 * types describing page, layout, and API route modules.
 *
 * @module
 */

// Server public surface: create/serve a denext app.

import { type AppConfig, createApp, type RequestHandler } from "./app.ts";
import { serveWithPortFallback } from "./serve-utils.ts";

export { createApp } from "./app.ts";
export type { AppConfig, FlightBoundaryState, RequestHandler, RequestLogInfo } from "./app.ts";
export { renderPage } from "./render-page.ts";
export type { PageContext, RenderedPage, RenderPageOptions, SignalSink } from "./render-page.ts";
// Flight (RSC) types, referenced by RenderedPage/DocumentOptions.
export type {
  FlightActionRef,
  FlightBigInt,
  FlightBoundary,
  FlightChannelRef,
  FlightClient,
  FlightDate,
  FlightEventHandler,
  FlightHost,
  FlightMap,
  FlightNode,
  FlightNonFinite,
  FlightPrimitive,
  FlightProps,
  FlightSet,
  FlightUrl,
  FlightValue,
} from "../jsx/render-to-flight.ts";
export { renderToFlight } from "../jsx/render-to-flight.ts";
export { renderToHtmlFlight, serializeFlight } from "../jsx/render-to-html-flight.ts";
export type { HtmlFlight, HtmlFlightOptions, IslandPayload } from "../jsx/render-to-html-flight.ts";
export type { HydrationStrategy } from "../runtime/lazy-directive.ts";
export { renderToFlightStream } from "../jsx/render-to-flight-stream.ts";
export type { FlightStreamOptions } from "../jsx/render-to-flight-stream.ts";
export { collapseHeadTags } from "../jsx/render-to-string.ts";
export type { HeadCollector, HeadTag } from "../jsx/render-to-string.ts";
export { renderDocument } from "./document.ts";
export type { DocumentOptions, HydrationData } from "./document.ts";
export { parseRange, serveStatic } from "./static.ts";
export { createOtaHandler, type OtaHandlerOptions, type OtaTarget } from "./ota-handler.ts";
export {
  inOtaRollout,
  type OtaChannel,
  type OtaChannelsFile,
  type OtaRollout,
  otaRolloutBucket,
} from "./ota-rollout.ts";
// Universal link / App Link association files (the config's `appLinks`), for a custom server.
export { createAppLinksHandler } from "./app-links.ts";
// Push from your own server: APNs (token auth, HTTP/2) and FCM HTTP v1, zero npm.
export {
  type ApnsConfig,
  createPushSender,
  type FcmConfig,
  type FcmServiceAccount,
  type LiveActivityPush,
  type PushErrorCode,
  type PushPayload,
  type PushResult,
  type PushSender,
  type PushSenderConfig,
  type PushTarget,
  sendPush,
} from "./push-send.ts";
export { serveWithPortFallback } from "./serve-utils.ts";
export type { ServeUtilOptions } from "./serve-utils.ts";
// Typed route handlers: phantom-typed Request/Response so the typed-API-client generator
// can recover request/response body shapes (see src/build/api-types.ts).
export { json } from "./typed-response.ts";
export type { TypedRequest, TypedResponse } from "./typed-response.ts";
// Typed API errors: throw an `ApiError` from a route handler for a structured JSON failure
// (status + code + data); the dispatch seam also maps redirect()/notFound()/… and the body cap.
export { ApiError, apiErrorResponse, ApiValidationError, isApiError } from "./api-error.ts";
export type {
  ApiErrorBody,
  ApiErrorInit,
  ApiValidationSource,
  BuiltinApiErrorCode,
} from "./api-error.ts";
export type { ApiDispatchOptions } from "./api.ts";
// Schema-validated route handlers (`defineApi`, the route twin of `defineAction`) and the
// first-party middleware for `createApi().use(...)`.
export { apiDefinitionOf, createApi, defineApi, documentsSecurity } from "./define-api.ts";
export type {
  ApiBuilder,
  ApiDefinition,
  ApiErr,
  ApiErrGuard,
  ApiErrorCodes,
  ApiHandlerInput,
  ApiHandlerResult,
  ApiMiddleware,
  ApiMiddlewareDocs,
  ApiMiddlewareInput,
  ApiRouteHandler,
  ApiRouteMeta,
  ErrorSpec,
  QueryRecord,
  SchemaInput,
  SchemaOutput,
} from "./define-api.ts";
export { cors, csrf, rateLimit, requireSession } from "./api-middleware.ts";
// Typed live queries: a validated, gated `useLive` source (`defineSubscription`).
export { defineSubscription } from "../runtime/define-subscription.ts";
export type {
  SubscriptionConfig,
  SubscriptionContext,
  SubscriptionRef,
} from "../runtime/define-subscription.ts";
export type { SubscriptionDef, SubscriptionRunContext } from "../runtime/server-action.ts";
// The restart policy a Live subscription (`restart`) and a channel publisher share.
export type { ResolvedBackoff, ResolvedRestart, RestartOptions } from "../runtime/restart.ts";
// Server-push channels: `createChannel` + `publish(key, payload)` → `useChannel` on the client.
export {
  broadcastChannelTransport,
  createChannel,
  inMemoryChannelTransport,
  isChannel,
  setChannelTransport,
  tapChannel,
} from "../runtime/channel.ts";
export type {
  Channel,
  ChannelConfig,
  ChannelContext,
  ChannelEvent,
  ChannelIdleReason,
  ChannelPublisher,
  ChannelPublisherContext,
  ChannelRef,
  ChannelTapHandlers,
  ChannelTransport,
} from "../runtime/channel.ts";
// The authorized server-side subscriber a protocol bridge (GraphQL subscriptions) hands a viewer.
export { ChannelAccessError, tapChannelAuthorized } from "./channel-subscriber.ts";
export type { AuthorizedTapOptions } from "./channel-subscriber.ts";
export type {
  ApiRateLimitOptions,
  CsrfDoubleSubmitOptions,
  CsrfOptions,
  RequireSessionOptions,
} from "./api-middleware.ts";
export type * from "./types.ts";

// Re-export the router and JSX types referenced by the public API so that they
// are documented as part of this entrypoint (type-only, no runtime effect).
export type {
  ApiRoute,
  PageRoute,
  RouteManifest,
  SegmentLevel,
  SlotRoutes,
} from "../router/manifest.ts";
export {
  type AsyncProps,
  asyncProps,
  type SearchParams,
  searchParamsRecord,
} from "../runtime/async-props.ts";
// Plugin contract (Workstream C): the semver-stable surface a plugin (e.g. a Pages
// Router) extends. `RouteSynthesizer` + the route/convention registrars are the
// route seam; the plugin types + registrars below are the request/build seams.
export type { RouteSynthesizer } from "../router/manifest.ts";
export { scanRoutes } from "../router/manifest.ts";
export type {
  DenextPlugin,
  EmittedAsset,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginPrepareContext,
  PluginPrepareStep,
  PluginRequestHandler,
  PluginTeardown,
  PrepareStepOptions,
} from "../plugin/mod.ts";
export type { Directive } from "../build/directives.ts";
export type { ApiMatch, MatchOptions, PageMatch } from "../router/match.ts";
export type { Intercept, RouteParams, Segment, SegmentKind } from "../router/segments.ts";
// Segment parser + matcher primitives — the reusable core of the router, exposed
// so a routing plugin (e.g. a Pages Router) can parse patterns and match paths.
export {
  compareSpecificity,
  matchSegments,
  parsePattern,
  specificity,
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

export {
  composeMiddleware,
  createMiddlewareRunner,
  NEXT,
  next,
  redirectResponse,
  REWRITE,
  rewrite,
  withHeaders,
} from "./middleware.ts";
// The throwing navigation signals also resolve from `denext/server` (the obvious import
// in a Server Component / Server Action), identical to the `denext` exports — `redirect`
// included, as in Next.js. Thrown from middleware, a redirect signal becomes the response
// `redirectResponse` would build (see src/server/middleware.ts).
export {
  forbidden,
  isControlSignal,
  isForbidden,
  isNotFound,
  isRedirect,
  isUnauthorized,
  notFound,
  permanentRedirect,
  redirect,
  RedirectType,
  unauthorized,
} from "../runtime/error-boundary.ts";
export type {
  MatchContext,
  MatcherCondition,
  MatcherEntry,
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

// The resolved CORS policy (`config.cors`) a request context and route dispatch carry.
export type { CorsPolicy } from "./cors.ts";
// Project configuration (denext.config): redirects / rewrites / headers / etc.
export {
  type AndroidAppLinks,
  type ApiBatchConfig,
  type AppleAppLinks,
  type AppLinksConfig,
  type CacheConfig,
  type CdnCacheHeadersConfig,
  type CompileConfig,
  type CompiledPattern,
  type CompilePermissions,
  type CompressConfig,
  type CorsConfig,
  type DenextCommand,
  type DenextConfig,
  type DesktopAppIcons,
  type DesktopCapabilitiesConfig,
  type DesktopConfig,
  type DesktopEntitlementValue,
  type DesktopExtraPermissions,
  type DesktopFsConfig,
  type DesktopInstallersConfig,
  type DesktopLinuxConfig,
  type DesktopMacosConfig,
  type DesktopPasskeysConfig,
  type DesktopShellConfig,
  type DesktopSidecarConfig,
  type DesktopSidecarLoginShellEnvConfig,
  type DesktopSidecarReadyConfig,
  type DesktopSidecarRestartConfig,
  type DesktopSidecarRunConfig,
  type DesktopSidecarShutdownConfig,
  type DesktopSize,
  type DesktopUiUpdateConfig,
  type DesktopUpdateConfig,
  type DesktopWindowConfig,
  type ExperimentalConfig,
  type HeaderRule,
  type HstsConfig,
  type ImagesConfig,
  type JobHistoryConfig,
  type JobsConfig,
  type LiveConfig,
  type LiveConnectionContext,
  type LiveLimits,
  type LiveSubscriptionRequest,
  type LocalPattern,
  type MdxConfig,
  type MobileAdaptiveIconConfig,
  type MobileConfig,
  type MobileFlavorConfig,
  type PlatformExtensionsConfig,
  type ReactNativeConfig,
  type RedirectRule,
  type RemotePattern,
  type ResolvedRules,
  type RewriteRule,
  safeRedirectLocation,
  type SpaConfig,
  type SpaDesktopConfig,
  type SpaProxyConfig,
  type SpaShellConfig,
  type SpaTanstackRouterConfig,
  type TailwindConfig,
} from "./config.ts";
export { defineConfig } from "./define-config.ts";

// Internationalized routing (optional default-locale prefix).
export {
  detectLocale,
  localeHref,
  localeMiddleware,
  parseAcceptLanguage,
  peelLocale,
  resolveMessages,
} from "./i18n.ts";
export type { I18nConfig, I18nDomain, PeeledLocale } from "./i18n.ts";
// i18n message catalog primitives (also power useTranslations() on the client).
export {
  interpolate,
  makeTranslate,
  type Messages,
  provideMessages,
  type TranslateFn,
  type TranslationVars,
} from "../runtime/i18n-messages.ts";

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
  clientIp,
  clientIpForLimits,
  connection,
  cookies,
  draftMode,
  headers,
  localServerOrigin,
  noStore,
  readonlyHeaders,
  requestId,
  requestSignal,
  setRequestTimeout,
} from "./request-context.ts";
export type { RequestCookie } from "./request-context.ts";
export { cappedBody, readCappedBody, STALLED, TOO_LARGE } from "./body.ts";
// User-Agent parsing (userAgent(request) / userAgentFromString(ua)).
export { type UserAgent, userAgent, userAgentFromString } from "./user-agent.ts";
export type {
  AwaitableCookieStore,
  AwaitableDraftMode,
  AwaitableHeaders,
  CookieSetOptions,
  CookieStore,
  DraftMode,
  DraftTokenStore,
  RequestContext,
  RouteRegistry,
} from "./request-context.ts";
export type { RenderScope } from "../runtime/render-scope.ts";
// Scheduled/background jobs: define one in `jobs/<name>.ts`, schedule it via `scheduledJobs`
// in denext.config.ts or a per-job `schedule`, and/or run it on demand (`runJob` / `denext job`).
export { defineJob, getJob, isJob, jobNames, registerJob, runJob } from "./jobs.ts";
export type { Job, JobBackoff, JobContext, JobDefinition, JobRetry, JobRunRecord } from "./jobs.ts";
export { sqliteJobHistoryStore } from "./job-history.ts";

// Supervision for long-lived server work (restart semantics, not process isolation): services in
// `services/<name>.ts` (or any `supervise(...)` tree), restarted with backoff per strategy,
// escalated past their intensity, stopped in reverse order on the server drain.
export {
  defineService,
  isService,
  isSupervisor,
  jobService,
  sidecarService,
  supervise,
  supervisionStatus,
  SupervisorError,
} from "./supervise.ts";
export type {
  BackoffOptions,
  ChildStatus,
  RestartPolicy,
  Service,
  ServiceAdapterOptions,
  ServiceContext,
  ServiceDefinition,
  SupervisableSidecar,
  SuperviseOptions,
  SupervisionEvent,
  SupervisionLog,
  SupervisionState,
  SupervisionStrategy,
  Supervisor,
  SupervisorStatus,
} from "./supervise.ts";
export type {
  JobHistory,
  JobHistoryCleared,
  JobHistoryOptions,
  JobHistoryPruneOptions,
  JobHistoryReadOptions,
  JobHistoryRow,
  JobHistoryRun,
  JobHistoryStore,
  SqliteJobHistoryStoreOptions,
} from "./job-history.ts";
export { postgresJobHistoryStore } from "./postgres-job-history.ts";
export type { PostgresJobHistoryStoreOptions } from "./postgres-job-history.ts";

// Signed-cookie sessions (auth primitive).
export { getSession } from "./session.ts";
export type { Session, SessionOptions } from "./session.ts";

// Absolute-URL helpers (public origin behind reverse proxies).
export { absoluteUrl, type OriginOptions, requestOrigin } from "./absolute-url.ts";

// Instrumentation (instrumentation.ts): register() + onRequestError().
export { type Instrumentation, type OnRequest } from "./instrumentation.ts";
export type {
  InstrumentationRequest,
  OnRequestError,
  OnServiceError,
  OnShutdown,
  RegisterFn,
  RequestErrorContext,
  ServiceErrorContext,
} from "./instrumentation.ts";

// Environment: .env loading + the client/server public-env isolation boundary.
export {
  isPublicEnvKey,
  loadEnv,
  type LoadEnvOptions,
  PUBLIC_ENV_PREFIXES,
  publicEnv,
} from "./env.ts";

// Data cache, request memoization, and ISR.
export {
  cache,
  cachedFetch,
  cacheLife,
  cacheStoreHealthy,
  cacheTag,
  getCacheStats,
  getCacheStore,
  inMemoryCacheStore,
  PageCache,
  refresh,
  registerCacheLifeProfiles,
  resetCacheStats,
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
  CacheStats,
  CacheStore,
  DataEntry,
  InvalidationEvent,
} from "./cache.ts";

// Durable CacheStore: a local SQLite file via Deno's built-in node:sqlite (real SQLite,
// zero-npm, no unstable flag). The default durable store — resolved automatically by the
// runtime (see resolveDefaultCacheStore), no setup.
export { sqliteCacheStore } from "./sqlite-cache.ts";
export type { SqliteCacheStoreOptions, SqliteDb, SqlValue } from "./sqlite-cache.ts";

// Postgres: the client seam (Deno.SQL or an adapted driver), the migration runner, and a
// CacheStore shared by every replica.
export {
  fromPostgresJs,
  isPostgresUrl,
  POSTGRES_UNSUPPORTED,
  postgresClient,
  PostgresUnsupportedError,
  sessionClient,
  withDirectConnection,
} from "./postgres.ts";
export type {
  DirectPairedClient,
  PostgresConnectionOptions,
  PostgresJsLike,
  SqlClient,
  SqlListener,
  SqlQuery,
  SqlRow,
} from "./postgres.ts";
export { migratePostgres, postgresMigrationStatus, withMigrationLock } from "./postgres-migrate.ts";
export {
  BOOT_DDL_ENV,
  BOOT_SCHEMA_MISSING,
  bootDdlEnabled,
  bootMigrate,
  BootSchemaError,
  frameworkMigrationSets,
  registerBootCheck,
  registerFrameworkMigrations,
} from "./postgres-boot.ts";
export type { BootMigrateOptions, FrameworkMigrationSet, SetSource } from "./postgres-boot.ts";
export { migrateSqlite, sqliteMigrationStatus } from "./sqlite-migrate.ts";
export type { SqliteMigrateOptions, SqliteMigrationDb } from "./sqlite-migrate.ts";
export { vectorSearchSql } from "./vector-sql.ts";
export type { VectorSearchSqlOptions } from "./vector-sql.ts";
export type {
  MigrateResult,
  Migration,
  MigrationLockOptions,
  MigrationState,
  MigrationStatus,
  PostgresMigrateOptions,
} from "./postgres-migrate.ts";
export { postgresCacheStore } from "./postgres-cache.ts";
export type { PostgresCacheStoreOptions } from "./postgres-cache.ts";
export { redisCacheStore } from "./redis-cache.ts";
export type { RedisCacheStoreOptions } from "./redis-cache.ts";
export { redisClient, RedisConnectionError, RedisError } from "./redis.ts";
export type {
  RedisClient,
  RedisClientOptions,
  RedisCommand,
  RedisConnectionOptions,
  RedisReply,
} from "./redis.ts";
export { denoKvCacheStore } from "./deno-kv-cache.ts";
export type { DenoKvCacheStoreOptions } from "./deno-kv-cache.ts";
export { DenoKvUnsupportedError } from "./deno-kv.ts";
export type {
  DenoKvConnectionOptions,
  KvAtomicLike,
  KvEntryLike,
  KvKey,
  KvKeyPart,
  KvLike,
} from "./deno-kv.ts";

// Server Actions — runtime registration + secure same-origin dispatch.
export { isServerAction, serverAction } from "../runtime/server-action.ts";
export type { ServerActionRef } from "../runtime/server-action.ts";
export type { ActionHandlerOptions } from "./action-handler.ts";
// Typed Server Actions: define an action with a validated, typed input + typed result.
export { ActionValidationError, defineAction } from "../runtime/define-action.ts";
export type {
  ActionData,
  ActionErr,
  ActionErrDetails,
  ActionErrGuard,
  ActionResult,
  FormFields,
  InputSpec,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
  TypedAction,
} from "../runtime/define-action.ts";

// Dynamic OG images: render JSX to a PNG (next/og-style ImageResponse).
export { ImageResponse, type ImageResponseOptions } from "./image-response.ts";
// Self-hosted image optimization endpoint (backs <Image loader={denextImageLoader}>).
export {
  type ImageOptimizeOptions,
  type ImageTransform,
  optimizeImage,
  transformImageBytes,
  type TransformImageOptions,
} from "./image-optimizer.ts";
export { type HealthCheck, type HealthCheckOptions, registerHealthCheck } from "./health.ts";
export {
  safeFetch,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
} from "./safe-fetch.ts";

// First-party auth: OAuth 2.0 / OIDC (+ Credentials) on signed-cookie sessions.
// `denextAuth(config)` is a plugin (add to `plugins` in denext.config); it
// auto-mounts `/auth/*`. Read the session anywhere with `auth()`. The same surface is the
// standalone `denext/auth` entry point.
export * from "./auth/public.ts";

// Metadata file conventions (sitemap.ts / robots.ts / manifest.ts / favicon.ico).
export {
  serializeRobots,
  serializeSitemap,
  serializeSitemapIndex,
  serveMetadataFile,
} from "./metadata-files.ts";
export type {
  OpenGraphImageResult,
  Robots,
  RobotsRule,
  Sitemap,
  SitemapEntry,
  SitemapIndexEntry,
  SitemapModule,
} from "./metadata-files.ts";

import { defaultLoader } from "./default-loader.ts";
export { defaultLoader };

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

// The current request context — the seam integrations (e.g. @denext/effect) read
// per-request state through; app code uses cookies()/headers()/getSession() instead.
export { currentContext } from "./request-context.ts";
export * from "./revenuecat.ts";
