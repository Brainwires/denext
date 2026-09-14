/**
 * The auth route table: one row per endpoint, matched against the path **after** the
 * configured `basePath` has been stripped. This is the single place the endpoint set is
 * declared — `routes.ts` only strips the prefix, matches a row, and calls it.
 *
 * Patterns are plain segment patterns (`/signin/:provider`), not `URLPattern`, so a
 * capture can be percent-decoded and an undecodable segment can fall through as "no
 * route" rather than throwing a `URIError`.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import {
  clientIpBucket,
  proxiedWithoutTrust,
  type RateLimiter,
  sessionReadKey,
  sessionReadLimiter,
  signinStartKey,
  signinStartLimiter,
} from "./rate-limit.ts";
import { handleCredentials } from "./routes-credentials.ts";
import { handleOAuthCallback, handleSignin } from "./routes-oauth.ts";
import { handleProviders, handleSession, handleSignout } from "./routes-session.ts";
import { type AuthRouteContext, findProvider, json } from "./routes-shared.ts";
import { handleCreateToken, handleListTokens, handleRevokeToken } from "./routes-tokens.ts";
import { isOAuthProvider } from "./types.ts";

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

/** The limiter and key builder behind one {@link AuthRouteLimit}. */
const LIMITS: Record<AuthRouteLimit, {
  limiter: (config: AuthRouteContext["config"]) => RateLimiter | null;
  key: (request: Request, options: { trustForwardedHeaders?: boolean }) => string;
}> = {
  "signin-start": { limiter: signinStartLimiter, key: signinStartKey },
  "session-read": { limiter: sessionReadLimiter, key: sessionReadKey },
};

/**
 * A per-IP dispatch gate: EVERY hit counts (not only failures), because what is being
 * bounded is the work the endpoint does for an unauthenticated caller — minting a PKCE
 * verifier, a `state`, a nonce and a signed transaction cookie on `/signin/:provider`; a
 * cookie verification plus a store read (and possibly a re-issue) on `/session`. Past the
 * budget the answer is a generic `429` with `Retry-After`; hostile input can't make it
 * throw, since the key is derived from the client IP alone.
 *
 * The gate is **skipped** for a request that arrived through an undeclared reverse proxy
 * ({@link proxiedWithoutTrust}): there every client looks like the proxy, so one bucket
 * would be shared app-wide and the budget would be an outage rather than a defence.
 */
async function guardLimit(
  ctx: AuthRouteContext,
  limit: AuthRouteLimit,
  handler: AuthRoute["handler"],
): Promise<Response | null> {
  const { limiter: limiterFor, key: keyFor } = LIMITS[limit];
  const limiter = limiterFor(ctx.config);
  if (!limiter || proxiedWithoutTrust(ctx.request, ctx.config)) return await handler(ctx);
  const options = { trustForwardedHeaders: ctx.config.trustForwardedHeaders };
  const key = keyFor(ctx.request, options);
  const retryAfter = await limiter.lockedOut(key);
  if (retryAfter !== null) {
    if (limit === "signin-start") {
      await emitAuthEvent(ctx.options, "signInFailed", {
        provider: ctx.params.provider,
        reason: "rate_limited",
        ip: clientIpBucket(ctx.request, options),
      });
    }
    return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
  }
  await limiter.fail(key);
  return await handler(ctx);
}

/** Wrap a row's handler in the gate its `limit` names; an ungated row passes through. */
function gated(route: AuthRoute): AuthRoute {
  const limit = route.limit;
  if (!limit) return route;
  const { handler } = route;
  return { ...route, handler: (ctx) => guardLimit(ctx, limit, handler) };
}

/**
 * `{basePath}/callback/:provider` — the one path whose verb depends on the provider:
 * GET is the OAuth/OIDC callback, POST the Credentials one, and anything else a `405`.
 */
function handleCallback(ctx: AuthRouteContext): Promise<Response> | Response {
  const provider = findProvider(ctx.config, ctx.params.provider);
  if (!provider) return json({ error: "unknown provider" }, 404);
  if (provider.type === "credentials" && ctx.method === "POST") {
    return handleCredentials(ctx, provider);
  }
  if (isOAuthProvider(provider) && ctx.method === "GET") {
    return handleOAuthCallback(ctx, provider);
  }
  return json({ error: "method not allowed" }, 405);
}

/** Every auth endpoint, in match order. Later waves add rows here. */
const declaredRoutes: readonly AuthRoute[] = [
  { method: "GET", pattern: "/session", handler: handleSession, limit: "session-read" },
  { method: "GET", pattern: "/providers", handler: handleProviders },
  { method: "POST", pattern: "/signout", handler: handleSignout },
  { method: "GET", pattern: "/signin/:provider", handler: handleSignin, limit: "signin-start" },
  { method: "*", pattern: "/callback/:provider", handler: handleCallback },
  // Bearer API tokens. Cookie session only — these three never read `Authorization`, so a
  // token can't mint or revoke another one. They answer `null` (→ a plain 404) when no
  // adapter can store tokens, i.e. when the feature isn't configured at all.
  { method: "POST", pattern: "/tokens", handler: handleCreateToken },
  { method: "GET", pattern: "/tokens", handler: handleListTokens },
  { method: "DELETE", pattern: "/tokens/:id", handler: handleRevokeToken },
];

/** The table the dispatcher matches against: every row with its `limit` gate applied. */
const authRoutes: readonly AuthRoute[] = declaredRoutes.map(gated);

/** A matched row plus the path parameters it captured. */
export interface AuthRouteMatch {
  /** The row that matched. */
  route: AuthRoute;
  /** The decoded `:name` captures. */
  params: Record<string, string>;
}

/**
 * Find the row for a request.
 *
 * @param method The upper-cased HTTP method.
 * @param path The request path with `basePath` already stripped (e.g. `"/signin/google"`).
 * @returns The match, or `null` when nothing claims the path — including an undecodable
 * `:name` segment, which is an unknown route rather than an error.
 */
export function matchAuthRoute(method: string, path: string): AuthRouteMatch | null {
  const segments = path.split("/");
  for (const route of authRoutes) {
    if (route.method !== "*" && route.method !== method) continue;
    const params = matchPattern(route.pattern, segments);
    if (params) return { route, params };
  }
  return null;
}

/** Match one pattern against the request's path segments, decoding `:name` captures. */
function matchPattern(
  pattern: string,
  segments: string[],
): Record<string, string> | null {
  const parts = pattern.split("/");
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith(":")) {
      if (part !== segments[i]) return null;
      continue;
    }
    const value = decodeSegment(segments[i]);
    if (value === null) return null;
    params[part.slice(1)] = value;
  }
  return params;
}

/** A non-empty, percent-decodable path segment, or `null` (→ a 404-like fall-through). */
function decodeSegment(segment: string): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
