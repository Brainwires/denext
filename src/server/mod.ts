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

import { toFileUrl } from "@std/path";
import { type AppConfig, createApp, type RequestHandler } from "./app.ts";
import type { ModuleLoader } from "./types.ts";
import { serveWithPortFallback } from "./serve-utils.ts";

export { createApp } from "./app.ts";
export type { AppConfig, RequestHandler, RequestLogInfo } from "./app.ts";
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
export { serveStatic } from "./static.ts";
export { createOtaHandler, type OtaHandlerOptions } from "./ota-handler.ts";
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
export { rateLimit, requireSession } from "./api-middleware.ts";
// Typed live queries: a validated, gated `useLive` source (`defineSubscription`).
export { defineSubscription } from "../runtime/define-subscription.ts";
export type {
  SubscriptionConfig,
  SubscriptionContext,
  SubscriptionRef,
} from "../runtime/define-subscription.ts";
export type { SubscriptionDef, SubscriptionRunContext } from "../runtime/server-action.ts";
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
  ChannelRef,
  ChannelTapHandlers,
  ChannelTransport,
} from "../runtime/channel.ts";
export type { ApiRateLimitOptions, RequireSessionOptions } from "./api-middleware.ts";
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
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
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
  redirect,
  redirectResponse,
  REWRITE,
  rewrite,
  withHeaders,
} from "./middleware.ts";
// The throwing navigation signals also resolve from `denext/server` (the obvious import
// in a Server Component / Server Action), identical to the `denext` exports.
export {
  forbidden,
  isControlSignal,
  isForbidden,
  isNotFound,
  isRedirect,
  isUnauthorized,
  notFound,
  permanentRedirect,
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

// Project configuration (denext.config): redirects / rewrites / headers / etc.
export {
  type ApiBatchConfig,
  type CacheConfig,
  type CompiledPattern,
  type DenextCommand,
  type DenextConfig,
  type ExperimentalConfig,
  type HeaderRule,
  type HstsConfig,
  type ImagesConfig,
  type LiveConfig,
  type LiveConnectionContext,
  type LiveLimits,
  type LiveSubscriptionRequest,
  type LocalPattern,
  type MdxConfig,
  type ReactNativeConfig,
  type RedirectRule,
  type RemotePattern,
  type ResolvedRules,
  type RewriteRule,
  safeRedirectLocation,
  type SpaConfig,
  type SpaDesktopConfig,
  type SpaProxyConfig,
  type TailwindConfig,
  type TasksConfig,
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
  connection,
  cookies,
  draftMode,
  headers,
  noStore,
  readonlyHeaders,
  requestId,
  requestSignal,
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
// Scheduled/background tasks: define one in `tasks/<name>.ts`, schedule it via `scheduledTasks`
// in denext.config.ts or a per-task `schedule`, and/or run it on demand (`runTask` / `denext task`).
export { defineTask, getTask, isTask, registerTask, runTask, taskNames } from "./tasks.ts";
export type { Task, TaskContext, TaskDefinition } from "./tasks.ts";

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
  RegisterFn,
  RequestErrorContext,
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

// Server Actions — runtime registration + secure same-origin dispatch.
export { isServerAction, serverAction } from "../runtime/server-action.ts";
export type { ServerActionRef } from "../runtime/server-action.ts";
export type { ActionHandlerOptions } from "./action-handler.ts";
// Typed Server Actions: define an action with a validated, typed input + typed result.
export { ActionValidationError, defineAction } from "../runtime/define-action.ts";
export type {
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
export { type ImageOptimizeOptions, optimizeImage } from "./image-optimizer.ts";
export {
  safeFetch,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
} from "./safe-fetch.ts";

// First-party auth: OAuth 2.0 / OIDC (+ Credentials) on signed-cookie sessions.
// `denextAuth(config)` is a plugin (add to `plugins` in denext.config); it
// auto-mounts `/auth/*`. Read the session anywhere with `auth()`.
export {
  activeAuthConfig,
  auth,
  denextAuth,
  pendingMfaSession,
  requireAuth,
  revokeAllSessions,
  revokeSession,
  updateAuthSession,
} from "./auth/mod.ts";
export type { RequireAuthOptions } from "./auth/mod.ts";
export {
  apple,
  auth0,
  credentials,
  discord,
  emailOtp,
  facebook,
  github,
  gitlab,
  google,
  keycloak,
  magicLink,
  microsoftEntra,
  oidc,
  okta,
  slack,
} from "./auth/providers.ts";
export type {
  Auth0Options,
  CredentialsOptions,
  EmailProviderOptions,
  GitLabOptions,
  KeycloakOptions,
  MicrosoftEntraOptions,
  OAuthClientOptions,
  OidcOptions,
  OktaOptions,
} from "./auth/providers.ts";
// Password hashing for the Credentials provider (salted scrypt via node:crypto).
export { hashPassword, verifyPassword } from "./auth/password.ts";
export type { HashPasswordOptions } from "./auth/password.ts";
// The hashing seam: swap scrypt for Argon2id/bcrypt without touching the auth flow.
export { scryptHasher } from "./auth/hasher.ts";
export type { Hasher } from "./auth/hasher.ts";
// The persistence port: users, linked accounts, credentials, tokens, MFA factors.
export type {
  AdapterAccount,
  AdapterAccountRef,
  AdapterUser,
  ApiTokenRecord,
  AuthAdapter,
  MaybePromise,
  MfaRecord,
  VerificationPurpose,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "./auth/adapter.ts";
// Brute-force protection for the credentials endpoint (`AuthConfig.rateLimit`).
export { inMemoryRateLimitStore } from "./auth/rate-limit.ts";
export type {
  InMemoryRateLimitStoreOptions,
  RateLimitOptions,
  RateLimitStore,
  RateLimitWindow,
} from "./auth/rate-limit.ts";
// Opt-in revocable sessions (`AuthConfig.sessionStore`): in-memory or node:sqlite.
export { inMemorySessionStore } from "./auth/session-store.ts";
export { inMemoryAuthAdapter } from "./auth/memory-adapter.ts";
export type { InMemoryAuthAdapterOptions } from "./auth/memory-adapter.ts";
export { sqliteAuthAdapter } from "./auth/sqlite-adapter.ts";
export type { SqliteAuthAdapterOptions } from "./auth/sqlite-adapter.ts";
export { requireBearer } from "./auth/bearer.ts";
export type { BearerContext, RequireBearerOptions } from "./auth/bearer.ts";
export { issueApiToken, listApiTokens, revokeApiToken, verifyApiToken } from "./auth/api-token.ts";
export type { IssueApiTokenOptions, IssuedApiToken } from "./auth/api-token.ts";
export type { InMemorySessionStoreOptions, SessionStore } from "./auth/session-store.ts";
export { sqliteSessionStore } from "./auth/sqlite-session-store.ts";
export type { SqliteSessionStoreOptions } from "./auth/sqlite-session-store.ts";
// Email verification + password reset — what `{basePath}/verify` and `/reset` run, callable
// from your own Server Actions too.
export {
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "./auth/email.ts";
export type { EmailRequestResult, ResetPasswordResult, VerifyEmailResult } from "./auth/email.ts";
// The TOTP second factor: the flows behind `{basePath}/mfa*` and their RFC 6238 primitives.
export {
  confirmTotp,
  disableTotp,
  enrollTotp,
  mfaStatus,
  spendMfaAttempt,
  verifySecondFactor,
} from "./auth/mfa.ts";
export type {
  ConfirmTotpResult,
  EnrollTotpResult,
  MfaAttemptResult,
  MfaMethod,
  MfaStatus,
  SecondFactorResult,
  TotpEnrollment,
} from "./auth/mfa.ts";
export { generateTotpSecret, totpAuthUri, verifyTotp } from "./auth/totp.ts";
export type { TotpAuthUriOptions, TotpVerifyOptions, TotpVerifyResult } from "./auth/totp.ts";
export { backupCodeMatcher, generateBackupCodes } from "./auth/backup-codes.ts";
export type { BackupCodes } from "./auth/backup-codes.ts";
export type {
  AuthCallbacks,
  AuthConfig,
  AuthCookieConfig,
  AuthEmailConfig,
  AuthEvents,
  AuthLogger,
  AuthMfaConfig,
  AuthorizedCallbackInput,
  AuthProvider,
  AuthSession,
  AuthSessionConfig,
  AuthUser,
  CredentialsProvider,
  EmailProvider,
  OAuthProvider,
  ProfileInput,
  SendVerificationRequest,
  VerificationRequestParams,
} from "./auth/types.ts";

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

// The current request context — the seam integrations (e.g. @denext/effect) read
// per-request state through; app code uses cookies()/headers()/getSession() instead.
export { currentContext } from "./request-context.ts";
