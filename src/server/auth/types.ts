/**
 * Shared types for denext auth: the normalized user/session shapes and the
 * provider contracts (OAuth 2.0 / OIDC and Credentials).
 *
 * @module
 */

import type { AdapterAccount, AdapterUser, AuthAdapter } from "./adapter.ts";
import type { Hasher } from "./hasher.ts";
import type { RateLimitOptions } from "./rate-limit.ts";
import type { SessionStore } from "./session-store.ts";

/** A normalized user profile — the non-sensitive identity denext stores in the session. */
export interface AuthUser {
  /** Stable provider-scoped user id. */
  id: string;
  /** Display name, if the provider supplies one. */
  name?: string;
  /** Email, if granted. Dropped by the built-in OIDC mappers when the provider marks
   * it `email_verified: false` — so an app that links accounts by email can't be fed
   * an attacker-chosen, unverified address. Check {@link emailVerified} before trusting
   * it for account linking. */
  email?: string;
  /** Whether the provider asserted the email is verified (`email_verified` claim).
   * `undefined` when the provider doesn't say. Never treat an unverified/absent value
   * as proof of ownership when linking to an existing local account. */
  emailVerified?: boolean;
  /** Avatar URL, if any. */
  image?: string;
  /**
   * Authorization roles carried in the session — what `requireAuth(request, { role })` and
   * `requireSession({ role })` match (any-of). Populate them in `callbacks.signIn` /
   * `callbacks.session`, or from an {@link ./adapter.ts | AuthAdapter} user record. Absent
   * means "no roles", so a role check on a session without them always refuses.
   */
  roles?: string[];
}

/** The signed (readable, tamper-evident) session payload. Never stores tokens/secrets. */
export interface AuthSession {
  /** The signed-in user. */
  user: AuthUser;
  /** The provider id that authenticated this session. */
  provider: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
  /**
   * The server-side session id — present only when `denextAuth` runs with a
   * `sessionStore`. Pass it to `revokeSession` to end this one session (e.g. "sign out
   * this device"); stateless sessions have no id.
   */
  sessionId?: string;
  /**
   * Payload version. Absent (or `1`) on a session issued before 2.5; `2` on every session
   * denext issues now. The cookie's MAC domain is unchanged, so a v1 cookie keeps
   * verifying — readers just treat the fields below as absent.
   */
  v?: 2;
  /**
   * When this session was established, epoch seconds. Absent on a v1 payload, where
   * readers infer `expiresAt - maxAge`. Sliding expiry extends `expiresAt`, never this.
   */
  issuedAt?: number;
  /**
   * Set while the user has passed the first factor but not yet the second. A pending
   * session **fails closed**: `auth()` reports `null` for it, so every guard built on
   * `auth()` (requireAuth, requireSession, Live `authorize`, Server Actions) refuses too.
   * Only the MFA endpoints read a pending session. Absent means the session is complete.
   */
  mfaPending?: true;
  /**
   * RFC 8176 authentication-method references — how the user proved identity
   * (e.g. `["pwd"]`, `["pwd", "otp"]`). Absent on a v1 payload; readers treat that as `[]`.
   */
  amr?: string[];
}

/** Raw inputs a provider maps into an {@link AuthUser}. */
export interface ProfileInput {
  /** The token endpoint response (access_token, id_token, …). */
  tokens: Record<string, unknown>;
  /** The userinfo endpoint response, if fetched. */
  userinfo?: Record<string, unknown>;
  /** The verified OIDC `id_token` claims, if present. */
  claims?: Record<string, unknown>;
  /**
   * The provider's email list, if a {@link OAuthProvider.userEmailsUrl} is configured
   * and fetched (e.g. GitHub `/user/emails`). Lets a synchronous mapper expose only a
   * verified address — the OAuth-provider analogue of the OIDC `email_verified` claim.
   */
  emails?: unknown[];
}

/** An OAuth 2.0 / OIDC provider (Authorization Code + PKCE). */
export interface OAuthProvider {
  /** URL-safe provider id (the `[provider]` route segment), e.g. `"google"`. */
  id: string;
  /** `"oidc"` verifies an `id_token`; `"oauth"` calls a userinfo endpoint. */
  type: "oauth" | "oidc";
  /** Authorization endpoint. */
  authorizationUrl: string;
  /** Token endpoint. */
  tokenUrl: string;
  /** Userinfo endpoint (OAuth providers, or OIDC when you prefer userinfo). */
  userinfoUrl?: string;
  /**
   * Optional endpoint returning the account's email list (e.g. GitHub
   * `/user/emails`), fetched with the access token after userinfo. Its result is
   * passed to {@link profile} as `emails`, so the mapper can pick a *verified* address
   * rather than trusting an unverified `userinfo.email`.
   */
  userEmailsUrl?: string;
  /** Expected `iss` for id_token verification (OIDC). */
  issuer?: string;
  /** JWKS URL for id_token signature keys (OIDC). */
  jwksUrl?: string;
  /** Requested scopes. */
  scopes: string[];
  /** OAuth client id. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** Map the token/userinfo/claims result to a normalized {@link AuthUser}. */
  profile: (input: ProfileInput) => AuthUser;
  /** Extra authorization-request query params (e.g. `{ access_type: "offline" }`). */
  authorizationParams?: Record<string, string>;
  /**
   * Hosts `safeFetch` may reach for this provider (token/userinfo/jwks). Derived
   * from the configured endpoints when omitted.
   */
  allowedHosts?: string[];
  /**
   * Fill the endpoints from the provider's OIDC discovery document
   * (`<issuer>/.well-known/openid-configuration`) instead of hard-coding them. The
   * fetched document must declare exactly this `issuer` or it is refused, and the
   * request is pinned to the issuer's host.
   */
  discovery?: { issuer: string };
  /**
   * Refuse an `id_token` whose `aud` lists audiences besides this client unless it also
   * carries an `azp` naming this client (RFC 7519 §4.1.3 / OIDC Core §3.1.3.7 step 4).
   * Defaults to **on**; set `false` only for a provider that legitimately mints
   * multi-audience tokens without `azp`.
   */
  strictAudience?: boolean;
  /**
   * DANGEROUS: when this provider returns an email that already belongs to a local
   * account, link to it even though that account's address is **unverified**. Off by
   * default, and off is the safe answer — an attacker who registers an unverified local
   * account with a victim's address would otherwise take it over at the victim's first
   * provider login.
   */
  allowDangerousEmailAccountLinking?: boolean;
}

/** A Credentials (e.g. email/password) provider. */
export interface CredentialsProvider {
  /** Provider id (the `[provider]` route segment), typically `"credentials"`. */
  id: string;
  /** Discriminant marking this as a credentials provider. */
  type: "credentials";
  /**
   * Validate submitted credentials and return the user, or `null` to reject.
   * MUST NOT leak whether an account exists (return `null` for an unknown account and
   * a wrong password alike) and must compare passwords in constant time — store hashes
   * from `hashPassword` and check with `verifyPassword` (both from `denext/server`).
   * Failed attempts are rate-limited by the framework (see `AuthConfig.rateLimit`).
   */
  authorize: (
    credentials: Record<string, string>,
  ) => Promise<AuthUser | null> | AuthUser | null;
}

/** Any configured provider. */
export type AuthProvider = OAuthProvider | CredentialsProvider;

/** True for an OAuth/OIDC provider (vs. Credentials). */
export function isOAuthProvider(p: AuthProvider): p is OAuthProvider {
  return p.type === "oauth" || p.type === "oidc";
}

/** What {@link AuthCallbacks.authorized} is asked about. */
export interface AuthorizedCallbackInput {
  /** The live session — already non-null and not MFA-pending when the callback runs. */
  session: AuthSession;
  /** The request being guarded. */
  request: Request;
}

/** Callbacks that let an app veto or enrich a sign-in. */
export interface AuthCallbacks {
  /** Return false to deny a sign-in, or a modified user to enrich the session. */
  signIn?: (user: AuthUser, provider: string) => Promise<boolean | AuthUser> | boolean | AuthUser;
  /** Adjust the session payload before it is issued. */
  session?: (session: AuthSession) => Promise<AuthSession> | AuthSession;
  /**
   * The authorization hook `requireAuth` consults once a live session exists — richer
   * than `role`, because it sees the request. Return `true` to allow, `false` to refuse
   * exactly as an unauthenticated request is refused (a redirect to the sign-in page
   * carrying `callbackUrl`), or your own `Response` (a 403 page, a JSON envelope) to have
   * it returned verbatim.
   */
  authorized?: (
    input: AuthorizedCallbackInput,
  ) => Promise<boolean | Response> | boolean | Response;
}

/** Where the framework logs; every method is optional and defaults to silence. */
export interface AuthLogger {
  /** Verbose flow tracing. */
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  /** A recoverable misconfiguration (never a secret). */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  /** A swallowed failure — a provider round-trip, an adapter write, an event handler. */
  error?: (message: string, error?: unknown) => void;
}

/**
 * Side-effect hooks on the auth lifecycle. A handler may be async; it is awaited, and a
 * throw is caught and routed to {@link AuthLogger.error} — an event handler can never
 * fail a sign-in.
 */
export interface AuthEvents {
  /** A session was issued. */
  signIn?: (payload: {
    /** The user the session carries. */
    user: AuthUser;
    /** The provider that authenticated them. */
    provider: string;
    /** True when this sign-in created the adapter user record. */
    isNewUser?: boolean;
  }) => Promise<void> | void;
  /** A session was cleared through `/signout`. */
  signOut?: (payload: {
    /** The session that ended, or `null` when there was none. */
    session: AuthSession | null;
  }) => Promise<void> | void;
  /** A sign-in attempt was refused (bad credentials, a denied callback, a bad state). */
  signInFailed?: (payload: {
    /** The provider id the attempt targeted, when known. */
    provider?: string;
    /**
     * A stable machine-readable reason: `"invalid_credentials"`, `"rate_limited"`,
     * `"access_denied"`, `"account_not_linked"`, or an OAuth failure code.
     */
    reason: string;
    /** The client IP the limiter keyed on, when the attempt came through a rate-limited route. */
    ip?: string;
  }) => Promise<void> | void;
  /** A server-side session was revoked (one device, or everywhere). */
  sessionRevoked?: (payload: {
    /** The session id, when one session was revoked. */
    sessionId?: string;
    /** The user id, when every session of a user was revoked. */
    userId?: string;
  }) => Promise<void> | void;
  /** An adapter user record was created. */
  createUser?: (payload: {
    /** The new record. */
    user: AdapterUser;
  }) => Promise<void> | void;
  /** A provider account was linked to an existing user. */
  linkAccount?: (payload: {
    /** The user the account now belongs to. */
    user: AdapterUser;
    /** The account that was linked. */
    account: AdapterAccount;
  }) => Promise<void> | void;
}

/** One auth cookie's name and attributes. */
export interface AuthCookieConfig {
  /**
   * The cookie name *before* the `__Host-` prefix. Defaults are `"denext_auth"` (session)
   * and `"denext_auth_tx"` (OAuth transaction) — changing one logs every existing session
   * of that kind out once.
   */
  name?: string;
  /**
   * Origin-lock the cookie with the `__Host-` name prefix (Secure + `Path=/` + no
   * `Domain`). **On by default**, and leaving it on is strongly recommended: it is what
   * stops a sibling subdomain reading or shadowing the cookie.
   */
  hostPrefix?: boolean;
  /** Cookie `SameSite` (default `"Lax"` — the OAuth callback is a top-level GET). */
  sameSite?: "Strict" | "Lax" | "None";
  /** Cookie `Path` (default `"/"`, and forced to `"/"` under `__Host-`). */
  path?: string;
}

/** Session lifetime + storage strategy. */
export interface AuthSessionConfig {
  /**
   * `"cookie"` (default) keeps the whole payload in the signed cookie — stateless,
   * multi-replica-safe, only expiry ends it. `"database"` stores the payload server-side
   * and puts only a random id in the cookie, so sessions are revocable; it requires a
   * store — either {@link AuthConfig.sessionStore} or an adapter that exposes
   * `sessions` — and throws at config time when neither is present.
   */
  strategy?: "cookie" | "database";
  /** Session lifetime in seconds (default 7 days). Overrides the legacy top-level `maxAge`. */
  maxAge?: number;
  /**
   * Refresh a session's expiry when it is older than this many seconds — "sliding"
   * sessions. `0` (the default) never refreshes. Only endpoints that own the `Response`
   * can set a cookie, so the refresh happens on `GET {basePath}/session`, `requireAuth`,
   * `requireSession` and `updateAuthSession()` — never inside a bare `auth()`.
   */
  updateAge?: number;
}

/** What {@link AuthConfig.sendVerificationRequest} is handed for each outbound token. */
export interface VerificationRequestParams {
  /** The address the token was issued to. */
  identifier: string;
  /** The absolute, ready-to-click URL carrying the token. */
  url: string;
  /** The raw token (for a one-time code you render rather than link). */
  token: string;
  /** Which flow issued it. */
  purpose: "email" | "reset" | "magic" | "otp";
  /** Expiry, epoch seconds. */
  expiresAt: number;
}

/**
 * Deliver a verification token. denext ships **no mailer** — email verification,
 * password reset, magic links and one-time codes all call this, and the flows that need
 * it refuse to start when it is absent.
 */
export type SendVerificationRequest = (
  params: VerificationRequestParams,
) => Promise<void> | void;

/** Configuration for {@link ../auth/mod.ts | denextAuth}. */
export interface AuthConfig {
  /** Configured providers. */
  providers: AuthProvider[];
  /**
   * HMAC signing secret(s) for the session cookie (rotate with an array). At least 32
   * chars: shorter warns in development and makes `denextAuth()` throw in production.
   */
  secret: string | string[];
  /**
   * The app's canonical origin (e.g. `https://example.com`). REQUIRED in production
   * so the OAuth `redirect_uri` is byte-stable and immune to Host-header injection.
   */
  canonicalOrigin?: string;
  /**
   * The app runs behind a proxy/load balancer that sets `x-forwarded-for`, so the
   * credentials rate limiter may key on that header's LAST hop (the one the proxy
   * appended). Off by default — without a proxy the header is attacker-controlled, and
   * the limiter keys on the socket peer instead. Mirrors the server-level option.
   */
  trustForwardedHeaders?: boolean;
  /** Optional sign-in/session callbacks. */
  callbacks?: AuthCallbacks;
  /** Session lifetime in seconds (default 7 days). */
  maxAge?: number;
  /** Where to send the user after sign-in / sign-out when no `callbackUrl` is given. */
  pages?: {
    /** The sign-in page (default `/`) — also where a refused guard redirects. */
    signIn?: string;
    /** Where a completed sign-in lands (default `/`). */
    afterSignIn?: string;
    /** Where a sign-out lands (default `/`). */
    afterSignOut?: string;
    /** Where a session that still owes a second factor is sent (default: `signIn`). */
    mfa?: string;
    /** The "check your email" page shown after a verification token is sent. */
    verifyRequest?: string;
    /** A page that renders `?error=` codes instead of the sign-in page. */
    error?: string;
  };
  /**
   * DANGEROUS: permit `http://localhost` providers in development (bypasses the
   * SSRF localhost block for token/userinfo/jwks). Never enable in production.
   */
  dangerouslyAllowInsecureProviders?: boolean;
  /**
   * Brute-force protection. ON by default: the Credentials endpoint allows 5 failed
   * attempts per client IP + identifier per 15 minutes, and `/signin/*` allows 20 sign-in
   * starts per client IP per 15 minutes (`rateLimit.signin`) — both answer a generic `429`.
   * Tune the limits, key, or store here, or pass `false` to disable both (e.g. you
   * rate-limit at the edge). The default store is per-process — pass a shared `store` for
   * multi-replica deployments.
   */
  rateLimit?: RateLimitOptions | false;
  /**
   * Opt in to **server-side, revocable sessions**. When set, the cookie carries only a
   * random session id and the payload lives in the store, so `revokeSession` /
   * `revokeAllSessions` end sessions immediately (a stolen cookie, a password change).
   * When unset (the default) sessions are stateless signed cookies — zero-config and
   * multi-replica-safe, but only expiry can end them. See `inMemorySessionStore` /
   * `sqliteSessionStore`, and note a per-process store isn't shared across replicas.
   */
  sessionStore?: SessionStore;
  /**
   * Where users, linked accounts, credentials, verification tokens, API tokens and MFA
   * factors are persisted. Optional: without one, denext stays the stateless
   * OAuth/Credentials layer it has always been and `session.user.id` is whatever the
   * provider's `profile` mapper returned. **With** one, sign-in resolves (or creates) an
   * adapter user and `session.user.id` becomes that adapter id. An adapter does **not**
   * make sessions stateful — see {@link AuthSessionConfig.strategy}.
   */
  adapter?: AuthAdapter;
  /** Session lifetime, sliding refresh, and cookie-vs-database storage. */
  session?: AuthSessionConfig;
  /**
   * Mount the endpoints under this prefix instead of `/auth` (e.g. `"/account/auth"`).
   * A leading slash is added and a trailing one stripped; `"/"` is refused, because the
   * handler would then claim every request.
   */
  basePath?: string;
  /** Override the session / OAuth-transaction cookie names and attributes. */
  cookies?: {
    /** The session cookie (default `__Host-denext_auth`). */
    session?: AuthCookieConfig;
    /** The short-lived OAuth transaction cookie (default `__Host-denext_auth_tx`). */
    transaction?: AuthCookieConfig;
  };
  /** Lifecycle hooks (sign-in, sign-out, failures, revocation, user/account creation). */
  events?: AuthEvents;
  /** Where the framework logs. Silent by default — auth never writes to the console. */
  logger?: AuthLogger;
  /**
   * How user-supplied secrets (Credentials passwords, MFA backup codes) are hashed and
   * checked. Defaults to `scryptHasher()`.
   */
  hasher?: Hasher;
  /**
   * Deliver a verification token (email verification, password reset, magic link, OTP).
   * denext ships no mailer; the flows that need one refuse to start without this.
   */
  sendVerificationRequest?: SendVerificationRequest;
}
