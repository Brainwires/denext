/**
 * denext's first-party auth surface, as one entry point: `denextAuth()` and `auth()`, the
 * guards, the provider presets, the adapters and stores, sessions and bearer tokens, email
 * verification and password reset, MFA, passkeys and SAML.
 *
 * Import it from `denext/auth`; `denext/server` re-exports the same names.
 *
 * ```ts
 * import { auth, denextAuth, github } from "denext/auth";
 * ```
 *
 * @module
 */

// First-party auth: OAuth 2.0 / OIDC (+ Credentials) on signed-cookie sessions.
// `denextAuth(config)` is a plugin (add to `plugins` in denext.config); it
// auto-mounts `/auth/*`. Read the session anywhere with `auth()`.
export {
  activeAuthConfig,
  auth,
  currentSessionId,
  denextAuth,
  pendingMfaSession,
  requireAuth,
  revokeAllSessions,
  revokeSession,
  updateAuthSession,
} from "./mod.ts";
export type { RequireAuthOptions } from "./mod.ts";
// The route-handler guard (`createApi().use(requireSession({ role }))`).
export { requireSession, type RequireSessionOptions } from "../api-middleware.ts";
export { nativeBearerToken } from "./native.ts";
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
} from "./providers.ts";
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
} from "./providers.ts";
// A zero-npm SMTP client for `sendVerificationRequest` (TLS required; STARTTLS or SMTPS).
export { SmtpError, smtpMailer, SmtpMessageError } from "./smtp.ts";
export type { MailMessage, SmtpContent, SmtpMailer, SmtpMailerOptions } from "./smtp.ts";
// Password hashing for the Credentials provider (salted scrypt via node:crypto).
export { hashPassword, verifyPassword } from "./password.ts";
export type { HashPasswordOptions } from "./password.ts";
// The hashing seam: swap scrypt for Argon2id/bcrypt without touching the auth flow.
export { scryptHasher } from "./hasher.ts";
export type { Hasher } from "./hasher.ts";
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
} from "./adapter.ts";
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
} from "./adapter-oauth-server.ts";
// Brute-force protection for the credentials endpoint (`AuthConfig.rateLimit`).
export { inMemoryRateLimitStore } from "./rate-limit.ts";
export type {
  InMemoryRateLimitStoreOptions,
  RateLimitOptions,
  RateLimitStore,
  RateLimitWindow,
} from "./rate-limit.ts";
// Opt-in revocable sessions (`AuthConfig.sessionStore`): in-memory or node:sqlite.
export { inMemorySessionStore } from "./session-store.ts";
export { inMemoryAuthAdapter } from "./memory-adapter.ts";
export type { InMemoryAuthAdapterOptions } from "./memory-adapter.ts";
export { sqliteAuthAdapter } from "./sqlite-adapter.ts";
export type { SqliteAuthAdapterOptions } from "./sqlite-adapter.ts";
export { requireBearer } from "./bearer.ts";
export type { BearerContext, RequireBearerOptions } from "./bearer.ts";
export { issueApiToken, listApiTokens, revokeApiToken, verifyApiToken } from "./api-token.ts";
export type { IssueApiTokenOptions, IssuedApiToken } from "./api-token.ts";
// Supabase-compatible keys and access tokens (`backend({ supabase })` from @denext/backend).
export {
  apiKeyRole,
  canSign,
  generateSupabaseKeys,
  installedSupabaseKeys,
  installSupabaseKeys,
  looksLikeJwt,
  opaqueKeyRole,
  resolveSupabaseKeys,
  signSupabaseJwt,
  SUPABASE_KEY_ENV,
  supabaseJwks,
  SupabaseKeyError,
  verifySupabaseJwt,
} from "./gotrue/keys.ts";
export type {
  GeneratedSupabaseKeys,
  SupabaseJwtClaims,
  SupabaseKeyErrorCode,
  SupabaseKeys,
  SupabaseKeysConfig,
  SupabaseRole,
  SupabaseSigningKey,
  VerifySupabaseJwtOptions,
} from "./gotrue/keys.ts";
export { jwtBearerOf, sessionFromClaims, verifyAccessToken } from "./gotrue/access.ts";
export { bearerTokenOf } from "./bearer-header.ts";
// The GoTrue-compatible `/auth/v1` API (`backend({ supabase })` mounts it).
export { handleGoTrueRequest, installGoTrue } from "./gotrue/handler.ts";
export type { GoTrueHandlerOptions } from "./gotrue/handler.ts";
export { refreshSsoMetadata } from "./gotrue/sso-refresh.ts";
export type { RefreshSsoMetadataOptions, SsoMetadataRefreshSummary } from "./gotrue/sso-refresh.ts";
export type { RefreshOutcome } from "./gotrue/sso-metadata.ts";
export { goTrueSmtpFromEnv } from "./gotrue/smtp-mail.ts";
export type { GoTrueMailKind, GoTrueSmtpOptions } from "./gotrue/smtp-mail.ts";
export { GoTrueError } from "./gotrue/errors.ts";
export type { GoTrueErrorCode } from "./gotrue/errors.ts";
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
} from "./gotrue/options.ts";
export type { InMemorySessionStoreOptions, SessionStore } from "./session-store.ts";
export { sqliteSessionStore } from "./sqlite-session-store.ts";
export type { SqliteSessionStoreOptions } from "./sqlite-session-store.ts";
// Postgres: the auth adapter, session and rate-limit stores shared by every replica — on the
// runtime's Deno.SQL, or any SqlClient (`fromPostgresJs` for the npm postgres package).
export { postgresAuthAdapter } from "./postgres-adapter.ts";
export type { PostgresAuthAdapterOptions } from "./postgres-adapter.ts";
export type { PostgresAuthStoreOptions } from "./postgres-schema.ts";
export { postgresSessionStore } from "./postgres-session-store.ts";
export type { PostgresSessionStoreOptions } from "./postgres-session-store.ts";
export { postgresRateLimitStore } from "./postgres-rate-limit.ts";
export type { PostgresRateLimitStoreOptions } from "./postgres-rate-limit.ts";
// Redis (7+ / Valkey) and Deno KV: the same shared stores, zero-npm (denext's own RESP client;
// Deno's built-in KV).
export { redisSessionStore } from "./redis-session-store.ts";
export type { RedisSessionStoreOptions } from "./redis-session-store.ts";
export { redisRateLimitStore } from "./redis-rate-limit.ts";
export type { RedisRateLimitStoreOptions } from "./redis-rate-limit.ts";
export { denoKvRateLimitStore, denoKvSessionStore } from "./deno-kv-stores.ts";
export type { DenoKvRateLimitStoreOptions, DenoKvSessionStoreOptions } from "./deno-kv-stores.ts";
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
} from "./saml/mod.ts";
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
} from "./saml/mod.ts";
// Email verification + password reset — what `{basePath}/verify` and `/reset` run, callable
// from your own Server Actions too.
export {
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "./email.ts";
export type { EmailRequestResult, ResetPasswordResult, VerifyEmailResult } from "./email.ts";
// The TOTP second factor: the flows behind `{basePath}/mfa*` and their RFC 6238 primitives.
export {
  confirmTotp,
  disableTotp,
  enrollTotp,
  mfaStatus,
  spendMfaAttempt,
  verifySecondFactor,
} from "./mfa.ts";
export type {
  ConfirmTotpResult,
  EnrollTotpResult,
  MfaAttemptResult,
  MfaMethod,
  MfaStatus,
  SecondFactorResult,
  TotpEnrollment,
} from "./mfa.ts";
export { generateTotpSecret, totpAuthUri, totpQrSvg, verifyTotp } from "./totp.ts";
export type {
  TotpAuthUriOptions,
  TotpQrSvgOptions,
  TotpVerifyOptions,
  TotpVerifyResult,
} from "./totp.ts";
// `denext auth reseal`: move TOTP factors off a retired `secret` (also callable from a job).
export { resealTotpFactors } from "./reseal.ts";
export type { ResealOptions, ResealReport } from "./reseal.ts";
// Passkeys (WebAuthn): the account-settings helpers behind `{basePath}/passkeys`.
export { deletePasskey, listPasskeys } from "./passkeys.ts";
export type { PasskeySummary } from "./passkeys.ts";
export { backupCodeMatcher, generateBackupCodes } from "./backup-codes.ts";
export type { BackupCodes } from "./backup-codes.ts";
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
  AuthSession,
  AuthSessionConfig,
  AuthSessionSaml,
  AuthUser,
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
} from "./types.ts";
