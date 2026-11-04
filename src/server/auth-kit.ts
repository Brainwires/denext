/**
 * The core internals `@denext/auth` is built on: the request context, signed cookies, request
 * bodies, CORS, the stores' Postgres / Redis / Deno KV / SQLite connections, the boot
 * migrations, the session types and the registry `auth()` reads through. The auth plugin is a
 * separate package (it keeps `@denext/denext` under JSR's size cap) that pins this denext
 * version exactly, so this entry point moves with denext and is **not** a stable API: build on
 * `denext/server` and `denext/plugin-kit` instead.
 *
 * @module
 */

export { absoluteUrl, requestOrigin } from "./absolute-url.ts";
export { ApiError } from "./api-error.ts";
export { isAndroidPackageName } from "./app-links.ts";
export { hasRole, registerAuthRuntime } from "./auth-registry.ts";
export type { AuthRuntime, RequireAuthOptions } from "./auth-registry.ts";
export type { AuthSession, AuthSessionSaml, AuthUser, SessionStore } from "./auth-session.ts";
export { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "./body.ts";
export { getCacheStore } from "./cache.ts";
export type { CacheStore } from "./cache.ts";
export { safeRedirectLocation } from "./config.ts";
export {
  applyCors,
  corsOriginAllowed,
  isPreflight,
  normalizeCorsOrigin,
  preflightResponse,
  resolveCors,
} from "./cors.ts";
export type { CorsPolicy } from "./cors.ts";
export { documentsErrors, documentsSecurity } from "./define-api.ts";
export type { ApiMiddleware } from "./define-api.ts";
export { kvHandle, listAll, retryCommit } from "./deno-kv.ts";
export type { DenoKvConnectionOptions, KvHandle, KvKey } from "./deno-kv.ts";
export { asciiDomain, emailKey } from "./email-key.ts";
export { constantTimeEqualHex, sha256Hex } from "./hash.ts";
export { registerHealthCheck } from "./health.ts";
export { originCandidate } from "./origin-check.ts";
export { hashPassword, verifyPassword } from "./password.ts";
export type { HashPasswordOptions } from "./password.ts";
export { isBuildPhase } from "./phase.ts";
export {
  bootMigrate,
  BootSchemaError,
  registerBootCheck,
  registerFrameworkMigrations,
} from "./postgres-boot.ts";
export type { FrameworkMigrationSet } from "./postgres-boot.ts";
export type { Migration } from "./postgres-migrate.ts";
export { resolveConnection, schemaPrefix, toNumber } from "./postgres.ts";
export type {
  PostgresConnectionOptions,
  ResolvedConnection,
  SqlClient,
  SqlRow,
} from "./postgres.ts";
export { randomToken } from "./random-token.ts";
export { inMemoryRateLimitStore } from "./rate-limit-store.ts";
export type {
  InMemoryRateLimitStoreOptions,
  RateLimitStore,
  RateLimitWindow,
} from "./rate-limit-store.ts";
export { resolveRedis } from "./redis.ts";
export type { RedisConnectionOptions, RedisReply } from "./redis.ts";
export {
  clientAddrOf,
  copyRemoteAddr,
  ipBucket,
  limitAddrOf,
  remoteAddrOf,
} from "./remote-addr.ts";
export type { Cidr, LimitAddrPolicy } from "./remote-addr.ts";
export {
  after,
  createRequestContext,
  currentContext,
  currentLimitPolicy,
  headers,
  runWithContext,
  trustsForwardedHeaders,
} from "./request-context.ts";
export type { RequestContextTrust } from "./request-context.ts";
export { inRootContext } from "./root-context.ts";
export { safeFetch } from "./safe-fetch.ts";
export {
  fromBase64Url,
  getSession,
  hmacSign,
  hmacVerify,
  isProductionEnv,
  isWeakSecret,
  toBase64Url,
} from "./session.ts";
export type { SessionOptions } from "./session.ts";
export type { SqliteDb, SqlValue } from "./sqlite-cache.ts";
export {
  apiKeyRole,
  installedSupabaseKeys,
  looksLikeJwt,
  signSupabaseJwt,
  supabaseJwks,
  SupabaseKeyError,
  verifySupabaseJwt,
} from "./supabase-keys.ts";
export type { SupabaseJwtClaims, SupabaseKeys, VerifySupabaseJwtOptions } from "./supabase-keys.ts";
export { encodeQr, renderQrSvg } from "../utils/qr-code.ts";
export type { QrEcc, QrEncodeOptions, QrMatrix, QrSvgOptions } from "../utils/qr-code.ts";
