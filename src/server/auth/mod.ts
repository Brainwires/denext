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

import type { DenextPlugin } from "../../plugin/mod.ts";
import { safeRedirectLocation } from "../config.ts";
import { isProductionEnv, isWeakSecret } from "../session.ts";
import { emitAuthEvent } from "./events.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { handleAuthRequest } from "./routes.ts";
import type { SessionStore } from "./session-store.ts";
import { readAuthSession, refreshIfStale } from "./session.ts";
import { isOAuthProvider } from "./types.ts";
import type { AuthConfig, AuthSession } from "./types.ts";

// The active config, captured when `denextAuth(config)` runs (at `denext.config`
// import). `auth()` reads it so a Server Component / middleware needs no handle.
let activeConfig: AuthConfig | null = null;

let warnedNoOrigin = false;

function validateConfig(config: AuthConfig): void {
  if (!config.secret || (Array.isArray(config.secret) && config.secret.length === 0)) {
    throw new Error("denextAuth: `secret` is required");
  }
  if (isWeakSecret(config.secret) && isProductionEnv()) {
    throw new Error(
      "denextAuth: `secret` is shorter than 32 chars — refusing to boot in production with " +
        "a brute-forceable session secret. Set a long, random secret (e.g. `openssl rand " +
        "-base64 32`).",
    );
  }
  validateProviders(config.providers);
  assertCredentialsVerifiable(config);
  warnOnUndeclaredProxy(config);
  // Resolving validates the 2.5 surface too: an unusable `basePath`, an invalid cookie
  // name, or `session.strategy: "database"` with nowhere to store sessions all throw here
  // — at config time, not on the first login.
  resolveAuthOptions(config);
  if (!config.canonicalOrigin) requireCanonicalOriginInProd();
  if (config.dangerouslyAllowInsecureProviders) {
    console.warn(
      "denextAuth: `dangerouslyAllowInsecureProviders` is on — localhost/insecure providers " +
        "are permitted. Never enable this in production.",
    );
  }
}

/** At least one provider, unique ids, and non-empty OAuth credentials. */
function validateProviders(providers: AuthConfig["providers"]): void {
  if (!providers || providers.length === 0) {
    throw new Error("denextAuth: at least one provider is required");
  }
  const seen = new Set<string>();
  for (const p of providers) {
    if (seen.has(p.id)) throw new Error(`denextAuth: duplicate provider id "${p.id}"`);
    seen.add(p.id);
    if (isOAuthProvider(p)) assertOAuthCredentials(p);
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
 * denext is behind something. If `trustForwardedHeaders` was never decided, say so once at
 * boot: without it every per-IP rate-limit bucket keys on the proxy rather than the
 * client, and `clientIp` reports the proxy to the app's own handlers too.
 */
function warnOnUndeclaredProxy(config: AuthConfig): void {
  if (!config.canonicalOrigin || config.trustForwardedHeaders !== undefined) return;
  if (warnedNoProxyTrust) return;
  warnedNoProxyTrust = true;
  console.warn(
    "denextAuth: `canonicalOrigin` is set but `trustForwardedHeaders` is not — if a reverse " +
      "proxy fronts this app, set it to true (only when the proxy OVERWRITES " +
      "`x-forwarded-for`) so rate limits and `signInFailed.ip` see the real client.",
  );
}

/**
 * `canonicalOrigin` is required in production: without it the OAuth redirect_uri and the
 * same-origin checks fall back to the attacker-controllable Host header. Detected via the
 * standard NODE_ENV/DENEXT_ENV=production signal a deploy sets; elsewhere warn once.
 */
function requireCanonicalOriginInProd(): void {
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
  validateConfig(config);
  activeConfig = config;
  return {
    name: "denext-auth",
    setup(ctx) {
      ctx.addRequestHandler((request) => handleAuthRequest(request, config));
      // Anything holding a resource (the sqlite handles) is released on server drain: the
      // session store, and the adapter — whose `close()` had never been wired up, so a
      // `sqliteAuthAdapter` kept its file handle open for the life of the process.
      const store = resolveAuthOptions(config).sessionStore;
      if (store?.close) ctx.addTeardown(() => store.close!());
      const adapter = config.adapter;
      if (adapter?.close) ctx.addTeardown(() => adapter.close!());
    },
  };
}

/** The resolved options plus the configured store, or throw: revocation needs one. */
function requireSessionStore(
  fn: string,
): { options: ResolvedAuthOptions; store: SessionStore } {
  const options = activeConfig ? resolveAuthOptions(activeConfig) : undefined;
  if (!options?.sessionStore) {
    throw new Error(
      `${fn}: no \`sessionStore\` is configured — sessions are stateless signed cookies, ` +
        "which can't be revoked before they expire. Pass `sessionStore` (e.g. " +
        "`sqliteSessionStore()`) to denextAuth to enable revocation.",
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
 * Revoke every server-side session of `userId` — "sign out everywhere", the right call
 * after a password change or a suspected cookie theft. Fires the `sessionRevoked` event.
 * Requires `denextAuth({ sessionStore })`; throws when sessions are stateless.
 *
 * @param userId The user whose sessions end.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const { options, store } = requireSessionStore("revokeAllSessions");
  await store.deleteByUser(userId);
  await emitAuthEvent(options, "sessionRevoked", { userId });
}

/**
 * The raw session for this request — **including** one that still owes a second factor.
 * Only the guards below (and, later, the MFA endpoints) may see a pending session;
 * everything else goes through {@link auth}, which hides it.
 */
function currentSession(): Promise<AuthSession | null> {
  if (!activeConfig) return Promise.resolve(null);
  return readAuthSession(activeConfig);
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
 * @returns The {@link AuthSession}, or `null`.
 */
export async function auth(): Promise<AuthSession | null> {
  const session = await currentSession();
  return session?.mfaPending ? null : session;
}

/**
 * Slide `session` forward when `session.updateAge` says it is stale. Shared by the guards
 * and {@link updateAuthSession}; the refreshed cookie rides the request's outgoing
 * headers, so only call it where the response has not been sent yet.
 */
function refreshActiveSession(session: AuthSession): Promise<AuthSession> {
  return activeConfig ? refreshIfStale(activeConfig, session) : Promise.resolve(session);
}

/**
 * Read the session **and** slide its expiry forward when `session.updateAge` has elapsed
 * — the explicit version of what `GET {basePath}/session`, {@link requireAuth} and
 * `requireSession()` do for you. Call it from a Server Action or a `route.ts` handler
 * (anywhere the response has not been sent yet); the refreshed cookie rides that
 * response. In a streamed Server Component use {@link auth} instead — a `Set-Cookie`
 * written after the headers flush is dropped silently.
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
    return refuse(request, options.signInPath ?? activeConfig?.pages?.mfa);
  }
  if (!hasRole(session, options.role)) return refuse(request, options.signInPath, "forbidden");
  const decision = await applyAuthorized(session, request);
  if (decision instanceof Response) return decision;
  if (decision === false) return refuse(request, options.signInPath);
  // Allowed: slide the expiry forward. Middleware runs inside the request context, so the
  // re-issued cookie is queued on the outgoing headers and the pipeline attaches it to
  // whatever response the request ends up producing — the "continue" case needs no
  // Response of its own.
  await refreshActiveSession(session);
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
  const authorized = activeConfig?.callbacks?.authorized;
  if (!authorized) return true;
  try {
    return await authorized({ session, request });
  } catch (error) {
    if (activeConfig) resolveAuthOptions(activeConfig).logger.error("authorized threw", error);
    return false;
  }
}

/** The refusal every guard shares: a 302 back to the sign-in page, carrying `callbackUrl`. */
function refuse(request: Request, signInPath?: string, error?: string): Response {
  const url = new URL(request.url);
  const signIn = signInPath ?? activeConfig?.pages?.signIn ?? "/";
  const reason = error ? `error=${encodeURIComponent(error)}&` : "";
  const target = safeRedirectLocation(
    `${signIn}?${reason}callbackUrl=${encodeURIComponent(url.pathname + url.search)}`,
  );
  return new Response(null, { status: 302, headers: { location: target } });
}

export type { AuthConfig, AuthSession } from "./types.ts";
