/**
 * First-party authentication for denext — a zero-npm, secure-by-default OAuth 2.0 /
 * OIDC (+ Credentials) layer on top of denext's signed-cookie sessions.
 *
 * Wire it in `denext.config.ts` as a plugin:
 * ```ts
 * import { denextAuth, google, credentials } from "@denext/denext/server";
 *
 * export default {
 *   plugins: [
 *     denextAuth({
 *       secret: Deno.env.get("AUTH_SECRET")!,
 *       canonicalOrigin: "https://example.com",
 *       providers: [
 *         google({ clientId: "…", clientSecret: "…" }),
 *         credentials({ authorize: async ({ email, password }) => lookupUser(email, password) }),
 *       ],
 *     }),
 *   ],
 * };
 * ```
 * The `/auth/*` endpoints mount automatically (no files to add). Read the session in
 * any Server Component, route handler, or middleware with {@link auth}.
 *
 * @module
 */

import { registerFrameworkMigrations } from "../postgres-boot.ts";
import { authMigrationSet } from "./postgres-schema.ts";
import { OAUTH_CHECKS } from "./oauth.ts";
import { backendPostgresClient } from "./backend-postgres.ts";
import type { DenextPlugin } from "../../plugin/mod.ts";
import { safeRedirectLocation } from "../config.ts";
import { isProductionEnv, isWeakSecret } from "../session.ts";
import { isBuildPhase } from "../phase.ts";
import { emitAuthEvent } from "./events.ts";
import { hasMfaAdapter, pendingSessionLive } from "./mfa.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { assertEmailProviderConfig } from "./providers-email.ts";
import { assertPhoneProviderConfig } from "./providers-phone.ts";
import { assertAnonymousConfig } from "./routes-anonymous.ts";
import { resolvePasskeys } from "./passkeys.ts";
import { authTrustsProxy } from "./rate-limit.ts";
import { handleAuthRequest } from "./routes.ts";
import { createAuthCommand } from "./command.ts";
import {
  nativeAdapterOf,
  nativeBearerOf,
  resolveNative,
  verifyNativeAccessToken,
} from "./native.ts";
import { currentContext, headers } from "../request-context.ts";
import { jwtBearerOf, sessionFromJwtBearer } from "./gotrue/access.ts";
import { keepsAuthLevel, type SessionStore } from "./session-store.ts";
import { endUserSessions, readAuthSession, refreshLiveSession } from "./session.ts";
import { isOAuthProvider } from "./types.ts";
import type { AuthConfig, AuthSession, OAuthProvider } from "./types.ts";

// The active config, captured when `denextAuth(config)` runs (at `denext.config`
// import). `auth()` reads it so a Server Component / middleware needs no handle.
let activeConfig: AuthConfig | null = null;

/** The request-context memo key of a config bound to one request ({@linkcode bindAuthConfig}). */
const REQUEST_CONFIG = Symbol.for("denext.auth.request-config");

/**
 * Make `config` the one `auth()` and the guards read for the rest of the current request,
 * whatever `denextAuth()` last activated for the process — for a compat layer whose config is
 * built per request (Auth.js's lazy `NextAuth((req) => config)`), so two concurrent requests
 * never read each other's. Outside a request it does nothing.
 *
 * @param config A config `denextAuth()` has validated.
 */
export function bindAuthConfig(config: AuthConfig): void {
  currentContext()?.memo.set(REQUEST_CONFIG, new Map([["config", config]]));
}

/** The config this request reads: the one bound to it, else the process's active one. */
function currentConfig(): AuthConfig | null {
  const bound = currentContext()?.memo.get(REQUEST_CONFIG)?.get("config");
  return (bound as AuthConfig | undefined) ?? activeConfig;
}

/**
 * The auth config `denextAuth()` was built with — the one `auth()` and the auth endpoints use.
 * Server code that needs the config itself (`requireBearer`, `issueApiToken`,
 * `requestPasswordReset`, …) can read it here instead of importing its own copy.
 *
 * @returns The active config.
 * @throws {Error} When no `denextAuth()` plugin has been created in this process.
 */
export function activeAuthConfig(): AuthConfig {
  const config = currentConfig();
  if (config === null) {
    throw new Error(
      "activeAuthConfig: no denextAuth() plugin has been created — add it to plugins in " +
        "denext.config.ts, or pass the auth config explicitly",
    );
  }
  return config;
}

/**
 * The active config, or `null` before `denextAuth()` has run — for a helper that can wait until
 * its first request to find it.
 *
 * @returns The active config, or `null`.
 */
export function peekActiveAuthConfig(): AuthConfig | null {
  return currentConfig();
}

let warnedNoOrigin = false;

/** Whether `secret` holds no usable value (unset, empty, or a list of only unset entries). */
function missingSecret(secret: AuthConfig["secret"]): boolean {
  return Array.isArray(secret) ? !secret.some((s) => typeof s === "string" && s !== "") : !secret;
}

/**
 * Under `denext build` / `denext export` the runtime secrets are usually absent (a Docker build
 * layer has no `.env`), and nothing is signed: a missing `secret` becomes a random one for the
 * run, so `denextAuth({ secret: Deno.env.get("AUTH_SECRET")! })` builds. Serving checks in full.
 */
function forBuildPhase(config: AuthConfig): AuthConfig {
  if (!isBuildPhase() || !missingSecret(config.secret)) return config;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { ...config, secret: btoa(String.fromCharCode(...bytes)) };
}

/** A brute-forceable secret is refused in production (checked when serving, not building). */
function assertStrongSecretInProd(secret: AuthConfig["secret"]): void {
  if (!isWeakSecret(secret) || !isProductionEnv() || isBuildPhase()) return;
  throw new Error(
    "denextAuth: `secret` is shorter than 32 chars — refusing to boot in production with " +
      "a brute-forceable session secret. Set a long, random secret (e.g. `openssl rand " +
      "-base64 32`).",
  );
}

function validateConfig(config: AuthConfig): void {
  if (!config.secret || (Array.isArray(config.secret) && config.secret.length === 0)) {
    throw new Error("denextAuth: `secret` is required");
  }
  assertStrongSecretInProd(config.secret);
  validateProviders(config.providers);
  assertCredentialsVerifiable(config);
  assertEmailProviderConfig(config);
  assertPhoneProviderConfig(config);
  assertAnonymousConfig(config);
  // Resolving validates the 2.5 surface too: an unusable `basePath`, an invalid cookie
  // name, or `session.strategy: "database"` with nowhere to store sessions all throw here
  // — at config time, not on the first login.
  const options = resolveAuthOptions(config);
  // `native`: registered redirect URIs and the adapter's native session group, checked now.
  resolveNative(config);
  // `passkeys`: the relying party (never derived from the Host header) and the adapter group.
  resolvePasskeys(config);
  if (options.mfa.required === "always" && !hasMfaAdapter(options)) {
    // Every sign-in would come back pending with no way to enroll or verify a factor:
    // nobody could ever finish signing in.
    throw new Error(
      'denextAuth: `mfa.required: "always"` needs an adapter with the MFA factor store ' +
        "(createMfaFactor, listMfaFactors, updateMfaFactor, claimMfaFactorStep, deleteMfaFactor) " +
        "and backup codes (getMfa, setMfa, consumeBackupCode).",
    );
  }
  assertMfaStoreKeepsAuthLevel(options);
  if (!config.canonicalOrigin) requireCanonicalOriginInProd();
  if (config.dangerouslyAllowInsecureProviders) {
    console.warn(
      "denextAuth: `dangerouslyAllowInsecureProviders` is on — localhost/insecure providers " +
        "are permitted. Never enable this in production.",
    );
  }
}

/**
 * MFA needs a session store that keeps a session's `authTime`, `amr` and `mfaPending`: over one
 * that drops them (the Auth.js adapter bridge's session rows) a session still owing its second
 * factor would read back as complete. Refuse the pairing — whenever MFA can run (the adapter
 * has the factor store, or `mfa.required: "always"`) — instead of signing anyone in past it.
 */
function assertMfaStoreKeepsAuthLevel(options: ResolvedAuthOptions): void {
  const store = options.sessionStore;
  if (!store || keepsAuthLevel(store)) return;
  if (!hasMfaAdapter(options) && options.mfa.required !== "always") return;
  throw new Error(
    "denextAuth: MFA can't run over the Auth.js adapter's database sessions — its session rows " +
      "keep no sign-in time, methods or pending second factor, so a half-signed-in session would " +
      'read back as complete. Use `session.strategy: "jwt"`, or a denext `sessionStore` ' +
      "(sqliteSessionStore(), postgresSessionStore(), …), with MFA.",
  );
}

/** At least one provider, unique ids, and non-empty OAuth credentials. */
function validateProviders(providers: AuthConfig["providers"]): void {
  const building = isBuildPhase();
  if (!providers || providers.length === 0) {
    throw new Error("denextAuth: at least one provider is required");
  }
  const seen = new Set<string>();
  for (const p of providers) {
    if (seen.has(p.id)) throw new Error(`denextAuth: duplicate provider id "${p.id}"`);
    seen.add(p.id);
    if (isOAuthProvider(p)) {
      // Client credentials come from the runtime environment: checked when serving.
      if (!building) assertOAuthCredentials(p);
      assertResponseMode(p);
      assertChecks(p);
      assertIdTokenAlg(p);
    }
  }
}

/**
 * `responseMode` must be one the callback answers, and `response_mode` must not ride in
 * `authorizationParams` instead: the provider would POST to a callback that expects a GET (or
 * the reverse), and the transaction cookie would have the wrong `SameSite`.
 */
function assertResponseMode(p: OAuthProvider): void {
  const mode: unknown = p.responseMode;
  if (mode !== undefined && mode !== "query" && mode !== "form_post") {
    throw new Error(
      `denextAuth: provider "${p.id}" has an unsupported responseMode ${JSON.stringify(mode)} — ` +
        'use "query" (the default) or "form_post".',
    );
  }
  if (p.authorizationParams && "response_mode" in p.authorizationParams) {
    throw new Error(
      `denextAuth: provider "${p.id}" sets response_mode in authorizationParams — set ` +
        '`responseMode: "form_post"` on the provider instead, so the callback and the ' +
        "transaction cookie follow it.",
    );
  }
}

/** `idTokenAlg` is `"HS256"` on an OIDC provider, or unset. */
function assertIdTokenAlg(p: OAuthProvider): void {
  if (p.idTokenAlg === undefined || (p.idTokenAlg === "HS256" && p.type === "oidc")) return;
  throw new Error(
    `denextAuth: provider "${p.id}" has idTokenAlg ${JSON.stringify(p.idTokenAlg)} — ` +
      'only an "oidc" provider takes it, and only "HS256".',
  );
}

/** `checks` names only the protections the flow knows (a typo must not drop PKCE silently). */
function assertChecks(p: OAuthProvider): void {
  if (p.checks === undefined) return;
  const unknown = Array.isArray(p.checks)
    ? p.checks.find((c) => !OAUTH_CHECKS.includes(c))
    : p.checks;
  if (unknown !== undefined) {
    throw new Error(
      `denextAuth: provider "${p.id}" has an unknown check ${JSON.stringify(unknown)} — ` +
        `\`checks\` lists ${OAUTH_CHECKS.map((c) => `"${c}"`).join(", ")}.`,
    );
  }
}

/**
 * A Credentials provider without `authorize` verifies against the adapter's credentials
 * group (`getUserByEmail` → `getCredential` → the configured `hasher`), so configuring one
 * needs an adapter that has that group. Caught here, at config time, instead of as every
 * login quietly answering `401`.
 *
 * @param config The app's auth config.
 * @throws {Error} Naming the provider and both fixes, when nothing could verify its logins.
 */
function assertCredentialsVerifiable(config: AuthConfig): void {
  const adapter = config.adapter;
  if (
    typeof adapter?.getUserByEmail === "function" && typeof adapter.getCredential === "function"
  ) {
    return;
  }
  const unverifiable = config.providers.find((p) => p.type === "credentials" && !p.authorize);
  if (!unverifiable) return;
  throw new Error(
    `denextAuth: the credentials provider "${unverifiable.id}" has no \`authorize\` and ` +
      (adapter
        ? "the configured `adapter` lacks the credentials group (`getUserByEmail` + " +
          "`getCredential`)"
        : "no `adapter` is configured") +
      ", so nothing can verify its logins. Either pass `authorize` to the provider, or " +
      "configure an `adapter` that implements `getUserByEmail` and `getCredential` (e.g. " +
      "`sqliteAuthAdapter({ path })`, or `inMemoryAuthAdapter()` in tests).",
  );
}

/**
 * Fail fast on empty OAuth credentials. A missing `Deno.env.get("…")!` coerces to the
 * string "undefined", which would otherwise be POSTed to the token endpoint and fail every
 * login at runtime with an opaque `?error=oauth_failed` and no boot signal. Catch it here,
 * at config time, with an actionable message.
 */
function assertOAuthCredentials(p: { id: string; clientId?: string; clientSecret?: string }): void {
  for (const field of ["clientId", "clientSecret"] as const) {
    const val = p[field];
    if (!val || val === "undefined" || val === "null") {
      throw new Error(
        `denextAuth: provider "${p.id}" has an invalid ${field} (${JSON.stringify(val)}) — ` +
          "check the environment variable it reads from is set.",
      );
    }
  }
}

/** Whether the proxy hint has already been printed (once per process). */
let warnedNoProxyTrust = false;

/**
 * A config with a `canonicalOrigin` is a config meant for production, and in production
 * denext is behind something. If proxy trust was decided neither on `denextAuth` nor at the
 * app level (`trustForwardedHeaders` in `denext.config.ts` / `DENEXT_TRUST_PROXY=1`, which
 * auth inherits), say so once, on the first auth request (the app-level setting is only
 * known then): without it every per-IP rate-limit bucket keys on the proxy rather than the
 * client, and `clientIp` reports the proxy to the app's own handlers too.
 */
function warnOnUndeclaredProxy(config: AuthConfig): void {
  if (warnedNoProxyTrust || !config.canonicalOrigin) return;
  if (config.trustForwardedHeaders !== undefined || authTrustsProxy(config)) return;
  warnedNoProxyTrust = true;
  console.warn(
    "denextAuth: `canonicalOrigin` is set but `trustForwardedHeaders` is not — if a reverse " +
      "proxy fronts this app, set `trustForwardedHeaders: true` in denext.config.ts (or " +
      "`DENEXT_TRUST_PROXY=1`; denextAuth inherits it) — only when the proxy OVERWRITES " +
      "`x-forwarded-for` — so rate limits, `signInFailed.ip` and `clientIp()` see the real client.",
  );
}

/**
 * `canonicalOrigin` is required in production: without it the OAuth redirect_uri and the
 * same-origin checks fall back to the attacker-controllable Host header. Detected via the
 * standard NODE_ENV/DENEXT_ENV=production signal a deploy sets; elsewhere warn once.
 */
function requireCanonicalOriginInProd(): void {
  // Building, not serving: the origin usually comes from the runtime environment.
  if (isBuildPhase()) return;
  if (isProductionEnv()) {
    throw new Error(
      "denextAuth: `canonicalOrigin` is required in production — without it the OAuth " +
        "redirect_uri and same-origin checks derive from the attacker-controllable Host " +
        'header. Set it, e.g. canonicalOrigin: "https://app.example.com".',
    );
  }
  if (warnedNoOrigin) return;
  warnedNoOrigin = true;
  console.warn(
    "denextAuth: no `canonicalOrigin` set — the OAuth redirect_uri is derived from the " +
      "Host header, which is attacker-controllable. Set it in production.",
  );
}

/**
 * Create the denext auth plugin. Add it to `plugins` in `denext.config.ts`; it
 * auto-mounts the `/auth/*` endpoints and makes {@link auth} available.
 *
 * @param config Providers, signing secret, canonical origin, and callbacks.
 * @returns A {@link DenextPlugin}.
 */
export function denextAuth(config: AuthConfig): DenextPlugin {
  config = forBuildPhase(config);
  validateConfig(config);
  activeConfig = config;
  return {
    name: "denext-auth",
    setup(ctx) {
      ctx.addRequestHandler((request) => {
        warnOnUndeclaredProxy(config);
        return handleAuthRequest(request, config);
      });
      // Anything holding a resource (the sqlite handles) is released on server drain: the
      // session store, and the adapter — whose `close()` had never been wired up, so a
      // `sqliteAuthAdapter` kept its file handle open for the life of the process.
      const store = resolveAuthOptions(config).sessionStore;
      if (store?.close) ctx.addTeardown(() => store.close!());
      const adapter = config.adapter;
      if (adapter?.close) ctx.addTeardown(() => adapter.close!());
      // With `@denext/backend`'s Postgres the rate limits and the SAML replay cache default onto
      // it (backend-postgres.ts), built on first use: declare their tables for `denext db push`.
      registerFrameworkMigrations(
        "auth:backend",
        () => backendPostgresClient() ? authMigrationSet(undefined, "denextAuth") : undefined,
      );
      // `denext auth reseal`: maintenance against this config's adapter and secret. (A
      // hand-built context in a test may omit the seam.)
      if (typeof ctx.addCommand === "function") ctx.addCommand(createAuthCommand(config));
    },
  };
}

/** The resolved options plus the configured store, or throw: revocation needs one. */
function requireSessionStore(
  fn: string,
): { options: ResolvedAuthOptions; store: SessionStore } {
  const config = currentConfig();
  const options = config ? resolveAuthOptions(config) : undefined;
  if (!options?.sessionStore) {
    throw new Error(
      `${fn}: no \`sessionStore\` is configured — sessions are stateless signed cookies, ` +
        "so one session can't be revoked by id (`revokeAllSessions(userId)` ends them all " +
        "through an adapter). Pass `sessionStore` (e.g. `sqliteSessionStore()`) to denextAuth " +
        "to revoke single sessions.",
    );
  }
  return { options, store: options.sessionStore };
}

/**
 * Revoke one server-side session by id (the `sessionId` on an {@link AuthSession}), so
 * its cookie stops authenticating immediately — "sign out this device". Fires the
 * `sessionRevoked` event. Requires `denextAuth({ sessionStore })`; throws when sessions
 * are stateless.
 *
 * @param sessionId The session to end.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  const { options, store } = requireSessionStore("revokeSession");
  await store.delete(sessionId);
  await emitAuthEvent(options, "sessionRevoked", { sessionId });
}

/**
 * Revoke every session of `userId` — "sign out everywhere", the right call after a password
 * change or a suspected cookie theft: the session store's records, every native app session
 * family when the adapter has that group, and — with an adapter — every cookie session signed
 * in before now, stateless ones included (the user's `sessionsValidAfter`). Fires the
 * `sessionRevoked` event. Throws when there is nothing to revoke through: no adapter and no
 * `sessionStore`.
 *
 * @param userId The user whose sessions end.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const config = currentConfig();
  const options = config ? resolveAuthOptions(config) : undefined;
  if (!options?.adapter && !options?.sessionStore) {
    throw new Error(
      "revokeAllSessions: no `adapter` or `sessionStore` is configured — stateless cookie " +
        "sessions are ended through the user record (`sessionsValidAfter`), so pass an " +
        "`adapter` (or a `sessionStore`) to denextAuth to enable revocation.",
    );
  }
  // Native app sessions (`native` config) end too — they need no session store.
  await nativeAdapterOf(options.adapter)?.revokeNativeSessionsByUser(userId);
  if (options.adapter) await endUserSessions(options.adapter, userId);
  await options.sessionStore?.deleteByUser(userId);
  await emitAuthEvent(options, "sessionRevoked", { userId });
}

/**
 * The raw session for this request — **including** one that still owes a second factor.
 * Only the guards below and {@link pendingMfaSession} may see a pending session;
 * everything else goes through {@link auth}, which hides it.
 */
function currentSession(): Promise<AuthSession | null> {
  const config = currentConfig();
  if (!config) return Promise.resolve(null);
  // A native app authenticates with `Authorization: Bearer nat_…` instead of the cookie. A
  // presented native token decides alone — an invalid one is signed out, never "fall back to
  // the cookie" — while any other Authorization (an API token) leaves the cookie path as is.
  // The header is read through `headers()`, the same guarded API the cookie path's
  // `cookies()` is: it marks the render dynamic (a bearer page is never stored by ISR and
  // answers `private, no-store`), postpones under PPR, throws inside `"use cache"` and reads
  // empty under `force-static` — a user's page can't be cached and served to the next visitor.
  const header = currentContext() ? headers().get("authorization") : null;
  const bearer = nativeBearerOf(header);
  if (bearer !== undefined) return verifyNativeAccessToken(config, bearer);
  // A Supabase access token (`backend({ supabase })`) is a session the same way; an `anon` /
  // `service_role` key in the header is not a user, and leaves the cookie to decide.
  const jwt = jwtBearerOf(header);
  if (jwt !== undefined) {
    return sessionFromJwtBearer(config, jwt).then((session) =>
      session === undefined ? readAuthSession(config) : session
    );
  }
  return readAuthSession(config);
}

/**
 * Read the current request's auth session, or `null` when signed out. Call from a
 * Server Component, a `route.ts` handler, or `middleware.ts` — anywhere inside the
 * request context.
 *
 * A session that has passed the first factor but not the second
 * ({@link AuthSession.mfaPending}) reads as `null` here — it **fails closed**, so every
 * guard built on `auth()` (requireAuth, requireSession, Live `authorize`, Server
 * Actions) refuses it without having to know MFA exists.
 *
 * With an adapter, a cookie session's user is re-read on every request (once per request,
 * however many times `auth()` is called): a deleted or banned user, and an SSO user (whose
 * identity provider never starts a denextAuth session), read as `null` from their very next
 * request. A bearer session's user is re-read the same way by its own verification.
 *
 * @returns The {@link AuthSession}, or `null`.
 */
export async function auth(): Promise<AuthSession | null> {
  const session = await currentSession();
  return session?.mfaPending ? null : session;
}

/**
 * The current request's session **only while it still owes a second factor** — `null`
 * for a complete session, and for none. For the app's `pages.mfa` page: render the code
 * form (or, under `mfa.required: "always"` for a user with no factor yet, the enrollment
 * step) when this returns a session, and redirect onward when it doesn't.
 *
 * A pending session grants nothing: {@link auth} and every guard still read it as signed
 * out, and it is never slid forward. It is short-lived, and the step-up replaces it with
 * a fresh session rather than upgrading it. One whose user has since been banned or deleted,
 * or whose address was first proven after it signed in, reads as `null` too.
 *
 * @returns The pending {@link AuthSession}, or `null`.
 */
export async function pendingMfaSession(): Promise<AuthSession | null> {
  const session = await currentSession();
  const config = currentConfig();
  if (!session?.mfaPending || !config) return null;
  return await pendingSessionLive(config, session) ? session : null;
}

/**
 * Slide `session` forward when `session.updateAge` says it is stale. Shared by the guards
 * and {@link updateAuthSession}; the refreshed cookie rides the request's outgoing
 * headers, so only call it where the response has not been sent yet.
 */
function refreshActiveSession(session: AuthSession): Promise<AuthSession | null> {
  // A native (bearer) session has no cookie to slide; its app refreshes its own token.
  if (session.nativeSessionId) return Promise.resolve(session);
  const config = currentConfig();
  return config ? refreshLiveSession(config, session) : Promise.resolve(session);
}

/**
 * Read the session **and** slide its expiry forward when `session.updateAge` has elapsed
 * — the explicit version of what `GET {basePath}/session`, {@link requireAuth} and
 * `requireSession()` do for you. Call it from a Server Action or a `route.ts` handler
 * (anywhere the response has not been sent yet); the refreshed cookie rides that
 * response. In a streamed Server Component use {@link auth} instead — a `Set-Cookie`
 * written after the headers flush is dropped silently. A session due to slide whose user is
 * an SSO user is ended instead (its identity provider is that user's only way in).
 *
 * @returns The (possibly refreshed) {@link AuthSession}, or `null` when signed out.
 */
export async function updateAuthSession(): Promise<AuthSession | null> {
  const session = await auth();
  return session ? await refreshActiveSession(session) : null;
}

/**
 * Whether a session carries at least one of the required roles (any-of).
 *
 * `undefined` means "no requirement" and allows everything. An **empty array** does not:
 * `role: []` names a set of acceptable roles that is empty, so nothing satisfies it and
 * this returns `false`. That is the fail-closed reading, and the one that matters — an
 * empty list is what a computed requirement (`role: user.requiredRoles`) degrades to when
 * the computation goes wrong, and it used to let every caller through. Use `undefined`
 * (or simply omit `role`) to mean "anyone signed in".
 *
 * A requirement against a session with no `roles` always refuses.
 *
 * @param session The live session.
 * @param role The required role, or roles (any one of which suffices).
 * @returns `true` when the session may proceed.
 */
export function hasRole(session: AuthSession, role: string | string[] | undefined): boolean {
  if (role === undefined) return true;
  const required = Array.isArray(role) ? role : [role];
  if (required.length === 0) return false;
  const held = session.user.roles;
  return !!held && required.some((r) => held.includes(r));
}

/** Options for {@link requireAuth}. */
export interface RequireAuthOptions {
  /** Where to send unauthenticated users (default: the config `pages.signIn` or `/`). */
  signInPath?: string;
  /**
   * Require at least one of these roles (`AuthUser.roles`) — any-of. A signed-in
   * user without a listed role is redirected to the sign-in page with `?error=forbidden`.
   */
  role?: string | string[];
}

/**
 * Middleware guard: allow the request through when signed in, otherwise return a
 * redirect to the sign-in page carrying a `callbackUrl` back to the target.
 *
 * Four checks, in order: no session → the sign-in page; a session still owing a second
 * factor → `pages.mfa` (or the sign-in page); `role` not held → the sign-in page with
 * `?error=forbidden`; then `callbacks.authorized({ session, request })` — `false` refuses
 * exactly like a missing session, and a returned `Response` is passed through verbatim.
 *
 * A request that passes all four also slides the session's expiry forward when
 * `session.updateAge` is configured — the re-issued cookie is queued on the request and
 * attached to the response the pipeline finalizes, so "continue" still carries it.
 *
 * Use in `middleware.ts` (matcher-gated):
 * ```ts
 * export async function middleware(request: Request) {
 *   return await requireAuth(request); // returns a Response to redirect, or null to continue
 * }
 * export const config = { matcher: ["/dashboard/:path*"] };
 * ```
 *
 * @param request The incoming request.
 * @param options Optional sign-in path override and `role` requirement.
 * @returns A redirect `Response` when unauthenticated, or `null` to continue.
 */
export async function requireAuth(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<Response | null> {
  const session = await currentSession();
  if (!session) return refuse(request, options.signInPath);
  // A half-authenticated session goes to the MFA page (falling back to sign-in), so the
  // user can finish the second factor instead of being bounced into a fresh login.
  if (session.mfaPending) {
    return refuse(request, options.signInPath ?? currentConfig()?.pages?.mfa);
  }
  if (!hasRole(session, options.role)) return refuse(request, options.signInPath, "forbidden");
  const decision = await applyAuthorized(session, request);
  if (decision instanceof Response) return decision;
  if (decision === false) return refuse(request, options.signInPath);
  // Allowed: slide the expiry forward. Middleware runs inside the request context, so the
  // re-issued cookie is queued on the outgoing headers and the pipeline attaches it to
  // whatever response the request ends up producing — the "continue" case needs no
  // Response of its own.
  // A session ended instead (an SSO user's, never its identity provider's) is signed out.
  if (!(await refreshActiveSession(session))) return refuse(request, options.signInPath);
  return null;
}

/**
 * Consult `callbacks.authorized`, treating a throw as a refusal — an authorization hook
 * that crashes must fail closed, never open.
 */
async function applyAuthorized(
  session: AuthSession,
  request: Request,
): Promise<boolean | Response> {
  const config = currentConfig();
  const authorized = config?.callbacks?.authorized;
  if (!authorized) return true;
  try {
    return await authorized({ session, request });
  } catch (error) {
    if (config) resolveAuthOptions(config).logger.error("authorized threw", error);
    return false;
  }
}

/** The refusal every guard shares: a 302 back to the sign-in page, carrying `callbackUrl`. */
function refuse(request: Request, signInPath?: string, error?: string): Response {
  const url = new URL(request.url);
  const signIn = signInPath ?? currentConfig()?.pages?.signIn ?? "/";
  const reason = error ? `error=${encodeURIComponent(error)}&` : "";
  const target = safeRedirectLocation(
    `${signIn}?${reason}callbackUrl=${encodeURIComponent(url.pathname + url.search)}`,
  );
  return new Response(null, { status: 302, headers: { location: target } });
}

export type { AuthConfig, AuthSession } from "./types.ts";
