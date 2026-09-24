/**
 * The auth route table: one row per endpoint, matched against the path **after** the
 * configured `basePath` has been stripped. This is the single place the endpoint set is
 * declared — `routes.ts` only strips the prefix, matches a row, and calls it. The rows
 * come from the route modules: session + sign-in (`routes-session`, `routes-oauth`), the
 * per-provider callback verbs (`routes-credentials`, `routes-oauth`, `routes-email`),
 * bearer tokens (`routes-tokens`), account recovery (`routes-account`) and the second
 * factor (`routes-mfa`).
 *
 * A row claims ONE method on its path: another verb falls through to the app (a plain
 * 404, or the app's own page — `GET {basePath}/reset` is where the reset link lands). Only
 * `/callback/:provider` answers every method, because its allowed verbs depend on the
 * provider's type; there a verb the type lacks is a `405`.
 *
 * Patterns are plain segment patterns (`/signin/:provider`), not `URLPattern`, so a
 * capture can be percent-decoded and an undecodable segment can fall through as "no
 * route" rather than throwing a `URIError`.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import {
  authTrustsProxy,
  clientIpBucket,
  proxiedWithoutTrust,
  type RateLimiter,
  sessionReadKey,
  sessionReadLimiter,
  signinStartKey,
  signinStartLimiter,
} from "./rate-limit.ts";
import { accountRoutes } from "./routes-account.ts";
import { handleCredentials } from "./routes-credentials.ts";
import { emailCallbacks } from "./routes-email.ts";
import { mfaRoutes } from "./routes-mfa.ts";
import { handleOAuthCallback, handleSignin } from "./routes-oauth.ts";
import { handleProviders, handleSession, handleSignout } from "./routes-session.ts";
import {
  type AuthRoute,
  type AuthRouteContext,
  type AuthRouteLimit,
  contained,
  findProvider,
  json,
} from "./routes-shared.ts";
import { handleCreateToken, handleListTokens, handleRevokeToken } from "./routes-tokens.ts";
import type { AuthProvider } from "./types.ts";

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
  const options = { trustForwardedHeaders: authTrustsProxy(ctx.config) };
  const key = keyFor(ctx.request, options);
  const retryAfter = await limiter.hit(key);
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
  return await handler(ctx);
}

/** Wrap a row's handler in the gate its `limit` names; an ungated row passes through. */
function gated(route: AuthRoute): AuthRoute {
  const limit = route.limit;
  if (!limit) return route;
  const { handler } = route;
  return { ...route, handler: (ctx) => guardLimit(ctx, limit, handler) };
}

/** The verbs a callback can answer. */
type CallbackVerb = "GET" | "POST";

/** The configured provider whose `type` is `T` (both OAuth flavours for `"oauth"`/`"oidc"`). */
type ProviderOfType<T extends AuthProvider["type"], P extends AuthProvider = AuthProvider> =
  P extends AuthProvider ? (T extends P["type"] ? P : never) : never;

/** One callback verb's handler, handed the provider already narrowed to its type. */
type CallbackHandler<P extends AuthProvider> = (
  ctx: AuthRouteContext,
  provider: P,
) => Promise<Response> | Response;

/**
 * `{basePath}/callback/:provider`, per provider type: the verbs it answers. GET is the
 * OAuth/OIDC redirect back and the magic-link click; POST the Credentials sign-in and the
 * email send/redeem. A verb missing here is a `405`.
 */
const CALLBACKS: {
  readonly [T in AuthProvider["type"]]: Partial<
    Record<CallbackVerb, CallbackHandler<ProviderOfType<T>>>
  >;
} = {
  credentials: { POST: handleCredentials },
  email: emailCallbacks,
  oauth: { GET: handleOAuthCallback },
  oidc: { GET: handleOAuthCallback },
};

/** Whether `method` is a verb some callback answers. */
function isCallbackVerb(method: string): method is CallbackVerb {
  return method === "GET" || method === "POST";
}

/**
 * The handler `provider`'s callback has for `method`, or `undefined` (→ `405`). The one
 * widening cast is sound: `CALLBACKS` is keyed by `provider.type`, and every entry takes
 * exactly the provider narrowed to that type.
 */
function callbackVerb(
  provider: AuthProvider,
  method: string,
): CallbackHandler<AuthProvider> | undefined {
  if (!isCallbackVerb(method)) return undefined;
  const verbs = CALLBACKS[provider.type] as Partial<
    Record<CallbackVerb, CallbackHandler<AuthProvider>>
  >;
  return verbs[method];
}

/**
 * `{basePath}/callback/:provider` — the one path whose verb depends on the provider: an
 * unknown provider is a `404`, a verb its type doesn't answer a `405`.
 */
function handleCallback(ctx: AuthRouteContext): Promise<Response> | Response {
  const provider = findProvider(ctx.config, ctx.params.provider);
  if (!provider) return json({ error: "unknown provider" }, 404);
  const handler = callbackVerb(provider, ctx.method);
  return handler ? handler(ctx, provider) : json({ error: "method not allowed" }, 405);
}

/** Every auth endpoint, in match order. */
const declaredRoutes: readonly AuthRoute[] = [
  { method: "GET", pattern: "/session", handler: handleSession, limit: "session-read" },
  { method: "GET", pattern: "/providers", handler: handleProviders },
  { method: "POST", pattern: "/signout", handler: handleSignout },
  { method: "GET", pattern: "/signin/:provider", handler: handleSignin, limit: "signin-start" },
  { method: "*", pattern: "/callback/:provider", handler: handleCallback },
  // Bearer API tokens. Cookie session only — these three never read `Authorization`, so a
  // token can't mint or revoke another one. They answer `null` (→ a plain 404) when no
  // adapter can store tokens, i.e. when the feature isn't configured at all.
  {
    method: "POST",
    pattern: "/tokens",
    handler: contained("minting an API token", handleCreateToken),
  },
  { method: "GET", pattern: "/tokens", handler: contained("listing API tokens", handleListTokens) },
  {
    method: "DELETE",
    pattern: "/tokens/:id",
    handler: contained("revoking an API token", handleRevokeToken),
  },
  // Email verification + password reset: GET/POST `/verify`, POST `/reset`, POST
  // `/reset/confirm` (the link click carries the per-IP `"session-read"` gate). They
  // answer `null` without an adapter that has the verification-token group.
  ...accountRoutes,
  // The second factor: POST `/mfa`, `/mfa/enroll`, `/mfa/confirm`, `/mfa/disable` — each
  // spends the per-user MFA budget itself, and answers `null` without the MFA group.
  ...mfaRoutes,
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
