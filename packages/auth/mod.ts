/**
 * `@denext/auth`: denext's first-party auth plugin. `denextAuth()` and its provider presets,
 * the adapters and stores, sessions and bearer tokens, email verification and password reset,
 * MFA, passkeys, SAML, the Supabase-compatible `/auth/v1` API, and the `next-auth` compat
 * (`@denext/auth/next-auth/*`).
 *
 * `auth()`, `requireAuth()`, `requireSession()` and the session types stay in `denext/server`
 * and read through the plugin once `denextAuth()` is in `plugins`:
 *
 * ```ts
 * // denext.config.ts
 * import { denextAuth, github } from "@denext/auth";
 * export default {
 *   plugins: [denextAuth({ secret: Deno.env.get("AUTH_SECRET")!, providers: [github({ … })] })],
 * };
 * // anywhere on the server
 * import { auth } from "denext/server";
 * const session = await auth();
 * ```
 *
 * @module
 */

// First-party auth: OAuth 2.0 / OIDC (+ Credentials) on signed-cookie sessions.
// `denextAuth(config)` is a plugin (add to `plugins` in denext.config); it
// auto-mounts `/auth/*`. Read the session anywhere with `auth()` from `denext/server`.
export {
  activeAuthConfig,
  currentSessionId,
  denextAuth,
  pendingMfaSession,
  revokeAllSessions,
  revokeSession,
  updateAuthSession,
} from "./src/mod.ts";

export { nativeBearerToken } from "./src/native.ts";
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
  phoneOtp,
  saml,
  slack,
} from "./src/providers.ts";
export type {
  Auth0Options,
  CredentialsOptions,
  EmailProviderOptions,
  GitLabOptions,
  KeycloakOptions,
  MagicLinkOptions,
  MicrosoftEntraOptions,
  OAuthClientOptions,
  OidcOptions,
  OktaOptions,
  PhoneProviderOptions,
  SamlProviderOptions,
} from "./src/providers.ts";
// A zero-npm SMTP client for `sendVerificationRequest` (TLS required; STARTTLS or SMTPS).
export { SmtpError, smtpMailer, SmtpMessageError } from "./src/smtp.ts";
export type { MailMessage, SmtpContent, SmtpMailer, SmtpMailerOptions } from "./src/smtp.ts";
// The hashing seam: swap scrypt for Argon2id/bcrypt without touching the auth flow
// (`hashPassword` / `verifyPassword` themselves are `denext/server`'s).
export { scryptHasher } from "./src/hasher.ts";
export type { Hasher } from "./src/hasher.ts";
// The persistence port: users, linked accounts, credentials, tokens, MFA factors.
export type {
  AdapterAccount,
  AdapterAccountRef,
  AdapterUser,
  ApiTokenRecord,
  AuthAdapter,
  MaybePromise,
  MfaFactorRecord,
  MfaRecord,
  NativeGrantRecord,
  NativeSessionRecord,
  PasskeyChallengeRecord,
  PasskeyRecord,
  SsoAttributeMapping,
  SsoAttributeMappingKey,
  SsoProviderRecord,
  SsoProviderWrite,
  SsoSessionIndexRecord,
  SsoSessionRecord,
  VerificationPurpose,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "./src/adapter.ts";
export type {
  CustomProviderAdapter,
  CustomProviderRecord,
  OAuthAuthorizationExpect,
  OAuthAuthorizationPatch,
  OAuthAuthorizationRecord,
  OAuthClientRecord,
  OAuthConsentRecord,
  OAuthServerAdapter,
  OAuthSessionLink,
  Web3NonceAdapter,
} from "./src/adapter-oauth-server.ts";
// Brute-force protection for the credentials endpoint (`AuthConfig.rateLimit`); the stores
// (`inMemoryRateLimitStore`, `RateLimitStore`) are `denext/server`'s.
export type { RateLimitOptions } from "./src/rate-limit.ts";
// Opt-in revocable sessions (`AuthConfig.sessionStore`): in-memory or node:sqlite.
export { inMemorySessionStore } from "./src/session-store.ts";
export { inMemoryAuthAdapter } from "./src/memory-adapter.ts";
export type { InMemoryAuthAdapterOptions } from "./src/memory-adapter.ts";
export { sqliteAuthAdapter } from "./src/sqlite-adapter.ts";
export type { SqliteAuthAdapterOptions } from "./src/sqlite-adapter.ts";
export { requireBearer } from "./src/bearer.ts";
export type { BearerContext, RequireBearerOptions } from "./src/bearer.ts";
export { issueApiToken, listApiTokens, revokeApiToken, verifyApiToken } from "./src/api-token.ts";
export type { IssueApiTokenOptions, IssuedApiToken } from "./src/api-token.ts";
// Supabase-compatible access tokens (`backend({ supabase })` from @denext/backend); the key
// minting and JWT signing (`generateSupabaseKeys`, `signSupabaseJwt`, …) are `denext/server`'s.
export { jwtBearerOf, sessionFromClaims, verifyAccessToken } from "./src/gotrue/access.ts";
export { bearerTokenOf } from "./src/bearer-header.ts";
// The GoTrue-compatible `/auth/v1` API (`backend({ supabase })` mounts it).
export { handleGoTrueRequest, installGoTrue } from "./src/gotrue/handler.ts";
export type { GoTrueHandlerOptions } from "./src/gotrue/handler.ts";
export { refreshSsoMetadata } from "./src/gotrue/sso-refresh.ts";
export type {
  RefreshSsoMetadataOptions,
  SsoMetadataRefreshSummary,
} from "./src/gotrue/sso-refresh.ts";
export type { RefreshOutcome } from "./src/gotrue/sso-metadata.ts";
export { goTrueSmtpFromEnv } from "./src/gotrue/smtp-mail.ts";
export type { GoTrueMailKind, GoTrueSmtpOptions } from "./src/gotrue/smtp-mail.ts";
export { GoTrueError } from "./src/gotrue/errors.ts";
export type { GoTrueErrorCode } from "./src/gotrue/errors.ts";
export type {
  GoTrueAccessTokenHookInput,
  GoTrueCaptchaOptions,
  GoTrueHooks,
  GoTrueOAuthServerOptions,
  GoTrueOptions,
  GoTrueSamlOptions,
  GoTrueSamlProvider,
  GoTrueSendEmailPayload,
  GoTrueSmsMessage,
  GoTrueWeb3Options,
} from "./src/gotrue/options.ts";
export type { InMemorySessionStoreOptions } from "./src/session-store.ts";
export { sqliteSessionStore } from "./src/sqlite-session-store.ts";
export type { SqliteSessionStoreOptions } from "./src/sqlite-session-store.ts";
// Postgres: the auth adapter, session and rate-limit stores shared by every replica — on the
// runtime's Deno.SQL, or any SqlClient (`fromPostgresJs` for the npm postgres package).
export { postgresAuthAdapter } from "./src/postgres-adapter.ts";
export type { PostgresAuthAdapterOptions } from "./src/postgres-adapter.ts";
export type { PostgresAuthStoreOptions } from "./src/postgres-schema.ts";
export { postgresSessionStore } from "./src/postgres-session-store.ts";
export type { PostgresSessionStoreOptions } from "./src/postgres-session-store.ts";
export { postgresRateLimitStore } from "./src/postgres-rate-limit.ts";
export type { PostgresRateLimitStoreOptions } from "./src/postgres-rate-limit.ts";
// Redis (7+ / Valkey) and Deno KV: the same shared stores, zero-npm (denext's own RESP client;
// Deno's built-in KV).
export { redisSessionStore } from "./src/redis-session-store.ts";
export type { RedisSessionStoreOptions } from "./src/redis-session-store.ts";
export { redisRateLimitStore } from "./src/redis-rate-limit.ts";
export type { RedisRateLimitStoreOptions } from "./src/redis-rate-limit.ts";
export { denoKvRateLimitStore, denoKvSessionStore } from "./src/deno-kv-stores.ts";
export type {
  DenoKvRateLimitStoreOptions,
  DenoKvSessionStoreOptions,
} from "./src/deno-kv-stores.ts";
// SAML 2.0 Service Provider primitives (IdP metadata, AuthnRequest, Response verification).
export {
  buildAuthnRequest,
  buildLogoutRequest,
  buildLogoutResponse,
  inMemorySamlReplayCache,
  parseIdpMetadata,
  peekLogoutMessage,
  SamlError,
  spMetadataXml,
  verifyLogoutRequest,
  verifyLogoutResponse,
  verifySamlResponse,
} from "./src/saml/mod.ts";
export type {
  BuildAuthnRequestOptions,
  BuildLogoutRequestOptions,
  BuildLogoutResponseOptions,
  ParsedIdpMetadata,
  PeekedLogoutMessage,
  SamlBindingInput,
  SamlErrorCode,
  SamlIdpConfig,
  SamlPrivateKey,
  SamlReplayCache,
  SamlSpConfig,
  VerifiedLogoutRequest,
  VerifiedLogoutResponse,
  VerifiedSamlAssertion,
  VerifyLogoutOptions,
  VerifySamlResponseOptions,
} from "./src/saml/mod.ts";
// Email verification + password reset — what `{basePath}/verify` and `/reset` run, callable
// from your own Server Actions too.
export {
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "./src/email.ts";
export type { EmailRequestResult, ResetPasswordResult, VerifyEmailResult } from "./src/email.ts";
// The TOTP second factor: the flows behind `{basePath}/mfa*` and their RFC 6238 primitives.
export {
  confirmTotp,
  disableTotp,
  enrollTotp,
  mfaStatus,
  spendMfaAttempt,
  verifySecondFactor,
} from "./src/mfa.ts";
export type {
  ConfirmTotpResult,
  EnrollTotpResult,
  MfaAttemptResult,
  MfaMethod,
  MfaStatus,
  SecondFactorResult,
  TotpEnrollment,
} from "./src/mfa.ts";
export { generateTotpSecret, totpAuthUri, totpQrSvg, verifyTotp } from "./src/totp.ts";
export type {
  TotpAuthUriOptions,
  TotpQrSvgOptions,
  TotpVerifyOptions,
  TotpVerifyResult,
} from "./src/totp.ts";
// `denext auth reseal`: move TOTP factors off a retired `secret` (also callable from a job).
export { resealTotpFactors } from "./src/reseal.ts";
export type { ResealOptions, ResealReport } from "./src/reseal.ts";
// Passkeys (WebAuthn): the account-settings helpers behind `{basePath}/passkeys`.
export { deletePasskey, listPasskeys } from "./src/passkeys.ts";
export type { PasskeySummary } from "./src/passkeys.ts";
export { backupCodeMatcher, generateBackupCodes } from "./src/backup-codes.ts";
export type { BackupCodes } from "./src/backup-codes.ts";
export type {
  AccountDeletedPayload,
  ApiTokenRevokedReason,
  AuthCallbacks,
  AuthConfig,
  AuthCookieConfig,
  AuthEmailConfig,
  AuthEvents,
  AuthLogger,
  AuthMfaConfig,
  AuthNativeConfig,
  AuthorizedCallbackInput,
  AuthPasskeyAndroidApp,
  AuthPasskeyConfig,
  AuthPasskeyMdsConfig,
  AuthPasskeyRevocationPolicy,
  AuthProvider,
  AuthSessionConfig,
  CredentialsProvider,
  EmailProvider,
  NativeAppleConfig,
  NativeIdTokenProviderConfig,
  OAuthCheck,
  OAuthProvider,
  PhoneProvider,
  ProfileInput,
  SamlProvider,
  SamlProviderSp,
  SendVerificationRequest,
  SignInFailedReason,
  TenantIssuer,
  UserinfoRequestInput,
  VerificationRequestParams,
} from "./src/types.ts";
