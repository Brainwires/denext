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

import { handleCredentials } from "./routes-credentials.ts";
import { handleOAuthCallback, handleSignin } from "./routes-oauth.ts";
import { handleProviders, handleSession, handleSignout } from "./routes-session.ts";
import { type AuthRouteContext, findProvider, json } from "./routes-shared.ts";
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
   * Answer the request.
   *
   * @param ctx The route context (request, config, resolved options, URL, params).
   * @returns The response, or `null` to fall through to the rest of the app.
   */
  handler(ctx: AuthRouteContext): Promise<Response | null> | Response | null;
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
const authRoutes: readonly AuthRoute[] = [
  { method: "GET", pattern: "/session", handler: handleSession },
  { method: "GET", pattern: "/providers", handler: handleProviders },
  { method: "POST", pattern: "/signout", handler: handleSignout },
  { method: "GET", pattern: "/signin/:provider", handler: handleSignin },
  { method: "*", pattern: "/callback/:provider", handler: handleCallback },
];

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
