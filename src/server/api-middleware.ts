// First-party middleware for `createApi().use(...)`: sessions, rate limits, CORS and CSRF.
//
//   const authed = createApi().use(rateLimit({ max: 60, windowMs: 60_000 })).use(requireSession());
//   export const GET = authed.define({ … }, ({ ctx }) => ctx.session.user.id);
//
// They run BEFORE validation (see `define-api.ts`), so a rejected caller never reaches a schema.
// `cors()` is the exception: it carries a policy the dispatch seam applies (a preflight never
// reaches a handler, and the headers must decorate error responses too).

import { type ApiMiddleware, type ApiMiddlewareInput, tagMiddlewareDocs } from "./define-api.ts";
import { ApiError } from "./api-error.ts";
import { hasRole, updatedSession } from "./auth-registry.ts";
import type { AuthSession } from "./auth-session.ts";
import { inMemoryRateLimitStore, type RateLimitStore } from "./rate-limit-store.ts";
import { ipBucket, limitAddrOf, remoteAddrOf } from "./remote-addr.ts";
import type { CorsConfig } from "./config.ts";
import { CORS_POLICY, resolveCors } from "./cors.ts";
import { verifyOrigin } from "./origin-check.ts";
import {
  cookies,
  currentContext,
  currentLimitPolicy,
  trustsForwardedHeaders,
} from "./request-context.ts";
import { randomToken } from "./random-token.ts";
import { constantTimeEqualHex } from "./hash.ts";
import { getCookies } from "@std/http/cookie";
import { requestOrigin } from "./absolute-url.ts";

/** Options for {@link requireSession}. */
export interface RequireSessionOptions {
  /** The 401's message (default `"Unauthorized"`). */
  message?: string;
  /**
   * Also require at least one of these roles (`AuthUser.roles`) — any-of. A signed-in
   * caller without a listed role fails with a 403 `forbidden` envelope, so "who are you"
   * and "may you" stay distinguishable to the client.
   */
  role?: string | string[];
  /** The 403's message when `role` is not held (default `"Forbidden"`). */
  forbiddenMessage?: string;
}

/**
 * Require a signed-in viewer (the `denextAuth()` plugin, `@denext/auth`): extends the context
 * with `{ session }`, or fails with a 401 `unauthorized` envelope before any schema runs. With `role`, a signed-in caller
 * who holds none of the listed roles fails with a 403 `forbidden` envelope instead.
 *
 * An API route owns its response, so this is also a sliding-expiry path: when
 * `session.updateAge` is configured and the session has aged past it, the session is
 * re-issued and the refreshed cookie rides the API response (see `updateAuthSession`).
 * Without the plugin the middleware throws an `AuthPluginMissingError` naming `@denext/auth`.
 *
 * @param options The 401 message, and optionally the required `role`(s).
 * @returns A middleware adding `session: AuthSession` to the handler's `ctx`.
 */
export function requireSession(
  options: RequireSessionOptions = {},
): ApiMiddleware<object, { session: AuthSession }> {
  const unauthorized = options.message ?? "Unauthorized";
  const forbidden = options.forbiddenMessage ?? "Forbidden";
  const mw: ApiMiddleware<object, { session: AuthSession }> = async () => {
    const session = await updatedSession();
    if (!session) throw new ApiError(401, "unauthorized", { message: unauthorized });
    if (!hasRole(session, options.role)) {
      throw new ApiError(403, "forbidden", { message: forbidden });
    }
    return { session };
  };
  // Documented for `@denext/openapi`: the 401 always, the 403 only when a role is required.
  return tagMiddlewareDocs(mw, {
    errors: {
      unauthorized: { status: 401, message: unauthorized },
      ...(options.role === undefined ? {} : { forbidden: { status: 403, message: forbidden } }),
    },
  });
}

/** Options for {@link rateLimit}. */
export interface ApiRateLimitOptions {
  /** Requests allowed per key per window. */
  max: number;
  /** The fixed window length in ms. */
  windowMs: number;
  /**
   * The bucket key (default: client IP + method + pathname). Use it to key per user
   * (`({ ctx }) => ctx.session.user.id`) once a session middleware has run.
   */
  key?: (input: ApiMiddlewareInput<object>) => string;
  /** Where counts live (default: a bounded in-memory store — per process; use a shared store behind replicas). */
  store?: RateLimitStore;
  /**
   * Whether to key on the LAST `x-forwarded-for` hop instead of the socket peer. Default: the
   * app's own `trustForwardedHeaders` / `DENEXT_TRUST_PROXY=1` (what `clientIp()` and
   * `clientIpForLimits()` follow); set it to override the app for this limiter.
   */
  trustForwardedHeaders?: boolean;
  /** The 429's message (default `"Too Many Requests"`). */
  message?: string;
}

/**
 * Fixed-window rate limit per key: the (max+1)th request in a window fails with a 429
 * `rate_limited` envelope carrying `retry-after` (seconds) — before validation, so a flood
 * never reaches a schema or the handler. The client identity is the socket peer, or the last
 * `x-forwarded-for` hop only when the proxy is trusted (a forged header can't dodge it): the
 * limiter's own `trustForwardedHeaders` when set, else the app's (`trustForwardedHeaders` /
 * `DENEXT_TRUST_PROXY=1`, read per request). An IPv6 address counts against its /64.
 *
 * The default key is skipped — the request is not limited — when the client address is a
 * loopback, private, link-local or unique-local socket peer and no trusted forwarded hop names
 * the client (`clientIpForLimits()`'s rule): that peer is most likely a reverse proxy every
 * visitor shares, so one bucket would rate-limit the whole site. A warning says so once per
 * process. The app's `rateLimitLocalAddresses` counts such a peer by its own address instead,
 * and its `rateLimitHeader` (e.g. `cf-connecting-ip`) keys on the address the proxy names there
 * whenever a request carries one — both app-wide, whatever this limiter's own
 * `trustForwardedHeaders`. A custom `key` is always applied.
 *
 * @param options Limit, window, key, store.
 * @returns A middleware (no context extension).
 */
export function rateLimit(options: ApiRateLimitOptions): ApiMiddleware<object> {
  const store = options.store ?? inMemoryRateLimitStore();
  const message = options.message ?? "Too Many Requests";
  const mw: ApiMiddleware<object> = async (input) => {
    const key = options.key
      ? options.key(input)
      : defaultKey(input, trustsForwardedHeaders(options.trustForwardedHeaders));
    if (key === null) return;
    const window = await store.increment(key, options.windowMs);
    if (window.count <= options.max) return;
    const retryAfter = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", {
      message,
      data: { retryAfter },
      headers: { "retry-after": String(retryAfter) },
    });
  };
  return tagMiddlewareDocs(mw, {
    errors: {
      rate_limited: {
        status: 429,
        message,
        headers: { "retry-after": "Seconds until the window resets" },
      },
    },
  });
}

/**
 * The default bucket: the client's limit address ({@link limitAddrOf}, IPv6 bucketed by /64) +
 * method + pathname. `null` when that address is an untrusted loopback/private peer (the limit is
 * skipped); `"unknown"` stands in when no peer was recorded at all (a handler called directly).
 */
function defaultKey(input: ApiMiddlewareInput<object>, trust: boolean): string | null {
  const request = input.request;
  const limitIp = limitAddrOf(request, trust, currentLimitPolicy());
  const peer = remoteAddrOf(request);
  if (limitIp === undefined && peer !== undefined) {
    warnProxyPeerOnce(peer);
    return null;
  }
  const ip = limitIp === undefined ? "unknown" : ipBucket(limitIp);
  return `${ip}|${input.method} ${new URL(request.url).pathname}`;
}

/** Whether {@link warnProxyPeerOnce} has logged (once per process). */
let warnedProxyPeer = false;

/**
 * Tell the operator once that `rateLimit()`'s per-address buckets are off: requests arrive from a
 * loopback/private socket peer (a reverse proxy — or local development) and the proxy is not
 * trusted.
 */
function warnProxyPeerOnce(peer: string): void {
  if (warnedProxyPeer) return;
  warnedProxyPeer = true;
  console.warn(
    `denext: API requests arrive from a loopback/private address (${peer}) — a reverse proxy, ` +
      "or local development — so rateLimit()'s per-address buckets are off for them (every " +
      "visitor would share one). Behind a proxy that sets x-forwarded-for, set the app's " +
      "`trustForwardedHeaders: true` (or DENEXT_TRUST_PROXY=1) to key each client's address; " +
      "behind one that sets a client-address header, name it in `rateLimitHeader`; to limit " +
      "these peers by their own address, set `rateLimitLocalAddresses: true`; or give " +
      "rateLimit() a `key` (a session's user id).",
  );
}

// ── cors() ───────────────────────────────────────────────────────────────────

/**
 * An allowlist-driven CORS policy for the endpoints a chain defines — the same exact-origin,
 * fail-closed rules as the app's `cors` config (`origins`, `methods`, `headers`,
 * `exposeHeaders`, `credentials`, `maxAge`), scoped to one endpoint. The framework answers a
 * preflight for the method the policy guards (`204`, before `middleware.ts` and before this
 * chain runs) and decorates every response the endpoint produces, errors included, with the
 * headers the request's origin is granted. It REPLACES the route's `export const cors` and the
 * app's `cors` for that method. The policy is validated here, so a bad one fails at import.
 *
 * CORS only tells a browser which origins may READ a response; pair it with {@link csrf} on a
 * cookie-authenticated endpoint to refuse the cross-site writes a browser still sends.
 *
 * @param config The policy (the {@link CorsConfig} shape).
 * @returns A middleware carrying the resolved policy (no context extension).
 */
export function cors(config: CorsConfig): ApiMiddleware<object> {
  const policy = resolveCors(config);
  if (!policy) throw new Error("denext: cors() needs a policy object with an `origins` array");
  const mw: ApiMiddleware<object> = () => undefined;
  Object.defineProperty(mw, CORS_POLICY, { value: policy });
  return mw;
}

// ── csrf() ───────────────────────────────────────────────────────────────────

/** The methods a CSRF check never applies to (they must not change state). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The double-submit cookie's default name. */
const DEFAULT_CSRF_COOKIE = "denext-csrf";
/** The double-submit header's default name. */
const DEFAULT_CSRF_HEADER = "x-csrf-token";

/** The double-submit half of {@link CsrfOptions}. */
export interface CsrfDoubleSubmitOptions {
  /**
   * The token cookie (readable by the page's script, `SameSite=Strict`). Default
   * `__Host-denext-csrf` on a secure request (https, or a trusted proxy's `x-forwarded-proto`)
   * — the prefix stops a sibling subdomain from planting a token of its own — and
   * `denext-csrf` over plain http. Either name is read; a secure request ignores the
   * unprefixed one. A name set here is used as given.
   */
  cookie?: string;
  /** The request header that must echo it (default `x-csrf-token`). */
  header?: string;
}

/** Options for {@link csrf}. */
export interface CsrfOptions {
  /**
   * Origins allowed to call on top of the app's own origin and `allowedOrigins` — full origins
   * (`https://admin.example.com`), bare hosts, or a custom-scheme app origin
   * (`capacitor://localhost`), matched exactly as Server Actions match them.
   */
  allowedOrigins?: string[];
  /**
   * Also require a double-submit token: the request must carry a header equal to the token
   * cookie, which this middleware issues on any request that lacks it (read it from
   * `document.cookie` and send it back). `true` uses the default names. Default `false` —
   * the origin check alone is denext's same-origin model.
   */
  doubleSubmit?: boolean | CsrfDoubleSubmitOptions;
  /**
   * Check a request that carries no `Cookie` header too (default `false`: with no cookie there
   * is no ambient credential to abuse, so a bearer-token or server-to-server caller passes).
   */
  checkCookieless?: boolean;
  /** The 403's message (default `"Cross-site request refused"`). */
  message?: string;
}

/**
 * Refuse cross-site state changes on a cookie-authenticated endpoint. A non-safe method
 * (anything but `GET`/`HEAD`/`OPTIONS`) must come from the app's own origin, `allowedOrigins`
 * (app config or these options) or the app's Deno Desktop origin — the `Origin` header, else
 * `Referer`, and neither present is a refusal: the same gate Server Actions, the typed-API batch
 * and `denextAuth` apply. With `doubleSubmit` the request must also echo the token cookie in a
 * header. A refusal is a 403 `csrf_failed` envelope, before any schema runs; the code is folded
 * into the endpoint's documented errors for `@denext/openapi`.
 *
 * @param options Extra origins, the double-submit token, cookieless handling.
 * @returns A middleware (no context extension).
 */
export function csrf(options: CsrfOptions = {}): ApiMiddleware<object> {
  const double = options.doubleSubmit === true ? {} : options.doubleSubmit || null;
  const cookieName = double?.cookie;
  const headerName = double?.header ?? DEFAULT_CSRF_HEADER;
  const refuse = (): never => {
    throw new ApiError(403, "csrf_failed", {
      message: options.message ?? "Cross-site request refused",
    });
  };
  const mw: ApiMiddleware<object> = ({ request, method }) => {
    const token = double ? ensureCsrfToken(request, cookieName) : null;
    if (SAFE_METHODS.has(method)) return;
    if (!options.checkCookieless && !request.headers.get("cookie")) return;
    if (!verifyOrigin(request, csrfOriginOptions(options.allowedOrigins))) refuse();
    if (token === null) return;
    const echoed = request.headers.get(headerName) ?? "";
    if (token === "" || !constantTimeEqualHex(echoed, token)) refuse();
  };
  return tagMiddlewareDocs(mw, { errors: { csrf_failed: 403 } });
}

/** The same-origin options Server Actions use, from the request context, plus `extra`. */
function csrfOriginOptions(extra: string[] = []) {
  const ctx = currentContext();
  return {
    allowedOrigins: [...(ctx?.originAllowlist?.allowedOrigins ?? []), ...extra],
    canonicalOrigin: ctx?.originAllowlist?.canonicalOrigin,
    trustForwardedHeaders: ctx?.trustForwardedHeaders,
    desktopAppOrigin: ctx?.desktopAppOrigin,
  };
}

/** The `__Host-`-prefixed default token cookie a secure request uses. */
const HOST_CSRF_COOKIE = `__Host-${DEFAULT_CSRF_COOKIE}`;

/**
 * Whether the client's connection is https: the request URL, or the first hop of
 * `x-forwarded-proto` when the app trusts its proxy (an untrusted one could be spoofed).
 */
function isSecureRequest(request: Request): boolean {
  const trustForwardedHeaders = currentContext()?.trustForwardedHeaders ?? false;
  return requestOrigin(request, { trustForwardedHeaders }).toLowerCase().startsWith("https://");
}

/** Which double-submit cookie names a request reads, which one it is issued, and `Secure`. */
interface CsrfCookie {
  read: string[];
  issue: string;
  secure: boolean;
}

/**
 * The double-submit cookie for `request`. A custom name is used as given. With the default, a
 * secure request reads and issues `__Host-denext-csrf` only — an unprefixed cookie is what a
 * sibling subdomain could plant — and plain http reads either name and issues `denext-csrf`
 * (a browser won't store a `__Host-` cookie without `Secure`).
 */
function csrfCookie(request: Request, custom: string | undefined): CsrfCookie {
  if (custom !== undefined) return { read: [custom], issue: custom, secure: false };
  if (isSecureRequest(request)) {
    return { read: [HOST_CSRF_COOKIE], issue: HOST_CSRF_COOKIE, secure: true };
  }
  return {
    read: [HOST_CSRF_COOKIE, DEFAULT_CSRF_COOKIE],
    issue: DEFAULT_CSRF_COOKIE,
    secure: false,
  };
}

/**
 * The request's double-submit token (`""` when it sent none), issuing a fresh token cookie
 * when it is missing so the page can echo it on its next write ({@link csrfCookie} names it).
 */
function ensureCsrfToken(request: Request, custom: string | undefined): string {
  const cookie = csrfCookie(request, custom);
  const jar = getCookies(request.headers);
  const sent = cookie.read.map((name) => jar[name]).find(Boolean);
  if (sent) return sent;
  if (currentContext()) {
    cookies().set(cookie.issue, randomToken(), {
      httpOnly: false,
      sameSite: "Strict",
      path: "/",
      ...(cookie.secure ? { secure: true } : {}),
    });
  }
  return "";
}
