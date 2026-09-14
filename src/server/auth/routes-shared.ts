/**
 * The pieces every auth endpoint shares: the request context a route handler receives,
 * the two response constructors (both `no-store`), the same-origin gate that guards every
 * state-changing POST, the redirect coercion that keeps `callbackUrl` on this origin, and
 * the signed `__Host-` transaction cookie the OAuth flow rides on.
 *
 * @module
 */

import { absoluteUrl } from "../absolute-url.ts";
import { safeRedirectLocation } from "../config.ts";
import { originCandidate } from "../origin-check.ts";
import { getSession, type SessionOptions } from "../session.ts";
import { cookieSessionOptions, type ResolvedAuthOptions } from "./options.ts";
import type { AuthConfig, AuthProvider, AuthUser } from "./types.ts";

/** Everything an auth route handler is handed. */
export interface AuthRouteContext {
  /** The incoming request. */
  request: Request;
  /** The app's auth config. */
  config: AuthConfig;
  /** The resolved options (base path, cookies, lifetimes, hasher, logger, events). */
  options: ResolvedAuthOptions;
  /** The parsed request URL. */
  url: URL;
  /** The upper-cased HTTP method. */
  method: string;
  /** Path parameters captured from the route pattern (e.g. `{ provider: "google" }`). */
  params: Record<string, string>;
}

/**
 * The method a row answers. `"*"` claims the path for every method and decides the
 * answer itself — `/callback/:provider` needs it, because which verb is allowed depends
 * on the provider's type (a GET is the OAuth callback, a POST the credentials one) and
 * anything else must be a `405`, not a fall-through.
 */
export type AuthRouteMethod = "GET" | "POST" | "DELETE" | "*";

/** One endpoint. */
export interface AuthRoute {
  /** The HTTP method this row answers, or `"*"` for "every method, handler decides". */
  method: AuthRouteMethod;
  /**
   * The path pattern relative to `basePath`, with a leading slash. A `:name` segment
   * captures one non-empty, percent-decodable segment into `ctx.params.name`.
   */
  pattern: string;
  /**
   * A dispatch-level rate-limit gate to put in front of the handler, if any.
   * `"signin-start"` is the per-client-IP budget for starting a sign-in (20 hits per
   * 15 minutes by default; `rateLimit.signin`), `"session-read"` the one for reading the
   * session (60 per minute; `rateLimit.session`). Declaring them here rather than inside
   * the handlers keeps the limits visible in the one place the endpoint set is declared —
   * and keeps the route modules free of limiter plumbing.
   */
  limit?: AuthRouteLimit;
  /**
   * Answer the request.
   *
   * @param ctx The route context (request, config, resolved options, URL, params).
   * @returns The response, or `null` to fall through to the rest of the app.
   */
  handler(ctx: AuthRouteContext): Promise<Response | null> | Response | null;
}

/** Which dispatch-level per-IP budget a row is gated by. */
export type AuthRouteLimit = "signin-start" | "session-read";

/**
 * The cache headers every auth response carries. Session state must never be stored by a
 * shared cache or a back/forward cache, so both response constructors below include them.
 */
function noStore(): Record<string, string> {
  return { "cache-control": "no-store" };
}

/**
 * A JSON response.
 *
 * @param body The value to serialize.
 * @param status HTTP status (default 200).
 * @param extraHeaders Headers merged after the defaults.
 * @returns The `Response`.
 */
export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...noStore(),
      ...extraHeaders,
    },
  });
}

/**
 * A redirect response.
 *
 * @param location The `Location` value (already coerced to a safe target).
 * @param status HTTP status (default 303).
 * @returns The `Response`.
 */
export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location, ...noStore() } });
}

/**
 * The configured provider with this id.
 *
 * @param config The auth config.
 * @param id The provider id from the URL.
 * @returns The provider, or `undefined`.
 */
export function findProvider(config: AuthConfig, id: string): AuthProvider | undefined {
  return config.providers.find((p) => p.id === id);
}

/**
 * Same-origin gate for state-changing POSTs (signout, credentials).
 *
 * @param request The incoming request.
 * @param config The auth config (its `canonicalOrigin` is matched when set).
 * @returns `true` when the request's Origin/Referer is this app.
 */
export function isSameOrigin(request: Request, config: AuthConfig): boolean {
  const u = originCandidate(request);
  if (!u) return false;
  // With a canonical origin configured, match it exactly (scheme-strict) — the Host
  // header is attacker-controllable and unnecessary here.
  if (config.canonicalOrigin) {
    try {
      return u.origin === new URL(config.canonicalOrigin).origin;
    } catch {
      return false;
    }
  }
  // Otherwise fall back to the request's own Host.
  const host = request.headers.get("host");
  return !!host && u.host === host;
}

/**
 * Coerce a **request-derived** redirect target to a same-origin path. `callbackUrl`
 * (query or POST body) is attacker-supplied, and {@link safeRedirectLocation} passes
 * a fully-qualified `http(s)://…` value through unchanged by design (its SEC-L3
 * note) — an open redirect. So an absolute URL is admitted only when its origin
 * matches the app's canonical origin, and then only its path is kept; any other
 * absolute URL falls back to the default. Relative values still go through
 * `safeRedirectLocation` (which pins them to the current origin).
 *
 * @param config The auth config (its `canonicalOrigin` decides what "same origin" means).
 * @param requested The attacker-supplied target, if any.
 * @param fallback Where to go when `requested` is absent or foreign.
 * @returns A safe `Location` value.
 */
export function sameOriginRedirect(
  config: AuthConfig,
  requested: string | null | undefined,
  fallback: string,
): string {
  if (requested && /^https?:\/\//i.test(requested)) {
    if (config.canonicalOrigin) {
      try {
        const u = new URL(requested);
        if (u.origin === new URL(config.canonicalOrigin).origin) {
          return safeRedirectLocation(u.pathname + u.search + u.hash);
        }
      } catch { /* fall through to the fallback */ }
    }
    return safeRedirectLocation(fallback);
  }
  return safeRedirectLocation(requested || fallback);
}

/**
 * Where a completed sign-in lands.
 *
 * @param config The auth config.
 * @param requested The requested `callbackUrl`, if any.
 * @returns A safe `Location` value.
 */
export function afterSignIn(config: AuthConfig, requested?: string | null): string {
  return sameOriginRedirect(config, requested, config.pages?.afterSignIn || "/");
}

/**
 * Where a sign-out lands.
 *
 * @param config The auth config.
 * @param requested The requested `callbackUrl`, if any.
 * @returns A safe `Location` value.
 */
export function afterSignOut(config: AuthConfig, requested?: string | null): string {
  return sameOriginRedirect(config, requested, config.pages?.afterSignOut || "/");
}

/**
 * Whether the caller wants a JSON answer rather than a redirect.
 *
 * @param request The incoming request.
 * @returns `true` for an `Accept: application/json` or `x-denext-auth: 1` client.
 */
export function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json") ||
    request.headers.get("x-denext-auth") === "1";
}

/**
 * The byte-stable redirect URI for a provider callback — the same string is sent on the
 * authorization request and the token exchange, so the provider's exact-match check passes.
 *
 * @param ctx The route context.
 * @param providerId The provider the callback belongs to.
 * @returns The absolute callback URL.
 */
export function callbackUri(ctx: AuthRouteContext, providerId: string): string {
  return absoluteUrl(ctx.request, `${ctx.options.prefix}callback/${providerId}`, {
    canonicalOrigin: ctx.config.canonicalOrigin,
  });
}

/**
 * Run the app's signIn callback: `false` denies, an object enriches, else pass through.
 *
 * @param config The auth config.
 * @param user The provider-mapped (or credentials-authorized) user.
 * @param providerId Which provider authenticated them.
 * @returns The user to issue a session for, or `null` when the app denied the sign-in.
 */
export async function applySignInCallback(
  config: AuthConfig,
  user: AuthUser,
  providerId: string,
): Promise<AuthUser | null> {
  if (!config.callbacks?.signIn) return user;
  const result = await config.callbacks.signIn(user, providerId);
  if (result === false) return null;
  if (result && typeof result === "object") return result;
  return user;
}

/** The in-flight OAuth transaction: CSRF `state`, PKCE verifier, OIDC `nonce`, return path. */
export interface Transaction {
  /** The provider the transaction was started for. */
  provider: string;
  /** The CSRF `state` the authorization request carried. */
  state: string;
  /** The PKCE code verifier. */
  verifier: string;
  /** The OIDC `nonce`, for an `oidc` provider. */
  nonce?: string;
  /** The already-coerced same-origin path to return to. */
  returnTo?: string;
}

/**
 * Signed, `__Host-`-prefixed, short-lived cookie carrying the OAuth transaction — so it
 * can't be forged or cross-subdomain overwritten (a login-CSRF vector for a plain one).
 */
function txSessionOptions(ctx: AuthRouteContext): SessionOptions {
  return cookieSessionOptions(ctx.config, ctx.options.cookies.transaction, 600);
}

/**
 * Store the in-flight OAuth transaction in its cookie.
 *
 * @param ctx The route context.
 * @param tx The transaction to sign and set.
 */
export async function setTx(ctx: AuthRouteContext, tx: Transaction): Promise<void> {
  const session = await getSession<Transaction>(txSessionOptions(ctx));
  await session.set(tx);
}

/**
 * Read the in-flight OAuth transaction.
 *
 * @param ctx The route context.
 * @returns The verified transaction, or `null` when absent/forged/expired.
 */
export async function readTx(ctx: AuthRouteContext): Promise<Transaction | null> {
  const session = await getSession<Transaction>(txSessionOptions(ctx));
  return session.data ?? null;
}

/**
 * Clear the OAuth transaction cookie — always, before the callback is judged, so a
 * transaction is single-use.
 *
 * @param ctx The route context.
 */
export async function clearTx(ctx: AuthRouteContext): Promise<void> {
  const session = await getSession<Transaction>(txSessionOptions(ctx));
  session.clear();
}
