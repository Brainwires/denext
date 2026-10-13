/**
 * The `/auth/v1` endpoint dispatcher — GoTrue's API, so the stock `supabase-js`
 * `supabase.auth.*` works against a denext app. `backend({ supabase })` mounts it; it serves
 * the users, sessions, MFA factors and identities `denextAuth()` keeps, so a cookie session
 * and a token session are the same user.
 *
 * @module
 */

import { absoluteUrl } from "../../absolute-url.ts";
import { activeAuthConfig } from "../mod.ts";
import { resolveAuthOptions } from "../options.ts";
import type { AuthConfig } from "../types.ts";
import { GOTRUE_PREFIX, type GoTrueContext, requireApiKey } from "./context.ts";
import { GoTrueError, goTrueErrorResponse } from "./errors.ts";
import { supabaseJwks, type SupabaseKeys } from "./keys.ts";
import type { GoTrueOptions } from "./options.ts";
import * as authRoutes from "./routes-auth.ts";
import * as userRoutes from "./routes-user.ts";
import * as factorRoutes from "./routes-factors.ts";
import * as adminRoutes from "./routes-admin.ts";
import * as oauthRoutes from "./routes-oauth.ts";
import { setGoTrueOAuthCallback } from "../routes-oauth.ts";
import * as ssoRoutes from "./routes-sso.ts";
import * as ssoAdminRoutes from "./routes-sso-admin.ts";
import { slo } from "./routes-slo.ts";

/** How one route is reached. */
interface Route {
  method: string;
  pattern: string;
  handler: (ctx: GoTrueContext) => Promise<Response> | Response;
  /** Who may call it: a client (`apikey`), nobody special (a browser navigation), the admin. */
  access: "apikey" | "open" | "admin";
}

const ROUTES: Route[] = [
  { method: "GET", pattern: "/health", handler: health, access: "open" },
  { method: "GET", pattern: "/settings", handler: authRoutes.settings, access: "apikey" },
  { method: "GET", pattern: "/.well-known/jwks.json", handler: jwks, access: "open" },
  { method: "POST", pattern: "/signup", handler: authRoutes.signup, access: "apikey" },
  { method: "POST", pattern: "/token", handler: authRoutes.token, access: "apikey" },
  { method: "POST", pattern: "/otp", handler: authRoutes.otp, access: "apikey" },
  { method: "POST", pattern: "/magiclink", handler: authRoutes.otp, access: "apikey" },
  { method: "POST", pattern: "/verify", handler: authRoutes.verifyPost, access: "apikey" },
  { method: "GET", pattern: "/verify", handler: authRoutes.verifyGet, access: "open" },
  { method: "POST", pattern: "/resend", handler: authRoutes.resend, access: "apikey" },
  { method: "POST", pattern: "/recover", handler: authRoutes.recover, access: "apikey" },
  { method: "POST", pattern: "/logout", handler: authRoutes.logout, access: "apikey" },
  { method: "GET", pattern: "/user", handler: userRoutes.getUser, access: "apikey" },
  { method: "PUT", pattern: "/user", handler: userRoutes.putUser, access: "apikey" },
  {
    method: "GET",
    pattern: "/reauthenticate",
    handler: userRoutes.reauthenticate,
    access: "apikey",
  },
  { method: "GET", pattern: "/authorize", handler: oauthRoutes.authorize, access: "open" },
  {
    method: "GET",
    pattern: "/user/identities/authorize",
    handler: oauthRoutes.authorizeLink,
    access: "apikey",
  },
  {
    method: "DELETE",
    pattern: "/user/identities/:id",
    handler: userRoutes.unlinkIdentity,
    access: "apikey",
  },
  { method: "POST", pattern: "/factors", handler: factorRoutes.enroll, access: "apikey" },
  {
    method: "POST",
    pattern: "/factors/:id/challenge",
    handler: factorRoutes.challenge,
    access: "apikey",
  },
  {
    method: "POST",
    pattern: "/factors/:id/verify",
    handler: factorRoutes.verify,
    access: "apikey",
  },
  { method: "DELETE", pattern: "/factors/:id", handler: factorRoutes.unenroll, access: "apikey" },
  { method: "POST", pattern: "/invite", handler: adminRoutes.adminInvite, access: "admin" },
  { method: "GET", pattern: "/admin/users", handler: adminRoutes.adminListUsers, access: "admin" },
  {
    method: "POST",
    pattern: "/admin/users",
    handler: adminRoutes.adminCreateUser,
    access: "admin",
  },
  {
    method: "GET",
    pattern: "/admin/users/:id",
    handler: adminRoutes.adminGetUser,
    access: "admin",
  },
  {
    method: "PUT",
    pattern: "/admin/users/:id",
    handler: adminRoutes.adminUpdateUser,
    access: "admin",
  },
  {
    method: "DELETE",
    pattern: "/admin/users/:id",
    handler: adminRoutes.adminDeleteUser,
    access: "admin",
  },
  {
    method: "GET",
    pattern: "/admin/users/:id/factors",
    handler: adminRoutes.adminListFactors,
    access: "admin",
  },
  {
    method: "DELETE",
    pattern: "/admin/users/:id/factors/:factor",
    handler: adminRoutes.adminDeleteFactor,
    access: "admin",
  },
  {
    method: "POST",
    pattern: "/admin/generate_link",
    handler: adminRoutes.adminGenerateLink,
    access: "admin",
  },
  { method: "POST", pattern: "/sso", handler: ssoRoutes.start, access: "apikey" },
  { method: "GET", pattern: "/sso/saml/metadata", handler: ssoRoutes.metadata, access: "open" },
  { method: "POST", pattern: "/sso/saml/acs", handler: ssoRoutes.acs, access: "open" },
  { method: "GET", pattern: "/sso/saml/slo", handler: slo, access: "open" },
  { method: "POST", pattern: "/sso/saml/slo", handler: slo, access: "open" },
  {
    method: "GET",
    pattern: "/admin/sso/providers",
    handler: ssoAdminRoutes.list,
    access: "admin",
  },
  {
    method: "POST",
    pattern: "/admin/sso/providers",
    handler: ssoAdminRoutes.create,
    access: "admin",
  },
  {
    method: "GET",
    pattern: "/admin/sso/providers/:id",
    handler: ssoAdminRoutes.get,
    access: "admin",
  },
  {
    method: "PUT",
    pattern: "/admin/sso/providers/:id",
    handler: ssoAdminRoutes.update,
    access: "admin",
  },
  {
    method: "DELETE",
    pattern: "/admin/sso/providers/:id",
    handler: ssoAdminRoutes.remove,
    access: "admin",
  },
];

function health(): Response {
  return Response.json({ version: "denext", name: "GoTrue", description: "denext /auth/v1" });
}

function jwks(ctx: GoTrueContext): Response {
  return Response.json(supabaseJwks(ctx.keys), {
    headers: { "cache-control": "public, max-age=600" },
  });
}

/** The path parameters when `path` fits `pattern`, else `null`. */
function fit(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split("/");
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    if (!part.startsWith(":")) {
      if (part !== segments[i]) return null;
      continue;
    }
    if (!segments[i]) return null;
    try {
      params[part.slice(1)] = decodeURIComponent(segments[i]);
    } catch {
      return null;
    }
  }
  return params;
}

function match(
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | "method" | null {
  const segments = path.split("/");
  let methodMismatch = false;
  for (const route of ROUTES) {
    const params = fit(route.pattern, segments);
    if (!params) continue;
    if (route.method === method) return { route, params };
    methodMismatch = true;
  }
  return methodMismatch ? "method" : null;
}

/** The CORS headers every `/auth/v1` answer carries: bearer-authenticated, so any origin. */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version, x-region",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  // A redirect is a navigation, not a CORS fetch; leave it alone.
  if (response.status >= 300 && response.status < 400) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/** What the handler needs besides the request. */
export interface GoTrueHandlerOptions {
  /** The `/auth/v1` options. */
  options: GoTrueOptions;
  /** The JWT keys. */
  keys: SupabaseKeys;
  /** The auth config (default: the one `denextAuth()` was built with). */
  config?: AuthConfig;
}

function configOf(handler: GoTrueHandlerOptions): AuthConfig {
  const config = handler.config ?? activeAuthConfig();
  if (!config.adapter) {
    throw new GoTrueError(
      500,
      "unexpected_failure",
      "/auth/v1 needs denextAuth({ adapter }) — the users live in the adapter",
    );
  }
  return config;
}

/** The per-request context. */
function contextFor(
  request: Request,
  url: URL,
  handler: GoTrueHandlerOptions,
  path: string,
  params: Record<string, string>,
): GoTrueContext {
  const config = configOf(handler);
  const origin = new URL(absoluteUrl(request, "/", { canonicalOrigin: config.canonicalOrigin }))
    .origin;
  return {
    request,
    url,
    method: request.method.toUpperCase(),
    path,
    params,
    config,
    adapter: config.adapter!,
    options: handler.options,
    keys: handler.keys,
    session: {
      config,
      options: handler.options,
      keys: handler.keys,
      issuer: `${origin}${GOTRUE_PREFIX}`,
    },
    origin,
    siteUrl: handler.options.siteUrl ?? config.canonicalOrigin ?? origin,
  };
}

/** Anything thrown, as the GoTrue error to answer (an unexpected one is logged, never shown). */
function asGoTrueError(error: unknown, handler: GoTrueHandlerOptions): GoTrueError {
  if (error instanceof GoTrueError) return error;
  try {
    resolveAuthOptions(handler.config ?? activeAuthConfig()).logger.error(
      "/auth/v1 request failed",
      error,
    );
  } catch {
    console.error("[denext] /auth/v1 request failed", error);
  }
  return new GoTrueError(500, "unexpected_failure", "Unexpected failure");
}

/**
 * Handle an `/auth/v1` request.
 *
 * @param request The request (app-relative: `basePath` already stripped).
 * @param handler The options, the keys and (optionally) the auth config.
 * @returns The response, or `null` for a path outside `/auth/v1`.
 */
export async function handleGoTrueRequest(
  request: Request,
  handler: GoTrueHandlerOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GOTRUE_PREFIX && !url.pathname.startsWith(GOTRUE_PREFIX + "/")) return null;
  const path = url.pathname.slice(GOTRUE_PREFIX.length) || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const found = match(method === "HEAD" ? "GET" : method, path);
    if (found === null) throw new GoTrueError(404, "not_found", "Not Found");
    if (found === "method") throw new GoTrueError(405, "method_not_allowed", "Method Not Allowed");
    const ctx = contextFor(request, url, handler, path, found.params);
    if (found.route.access === "apikey") await requireApiKey(ctx);
    if (found.route.access === "admin") await adminRoutes.requireAdmin(ctx);
    return withCors(await found.route.handler(ctx));
  } catch (error) {
    return withCors(goTrueErrorResponse(asGoTrueError(error, handler)));
  }
}

/**
 * Mount the `/auth/v1` flows that finish outside its own paths — an OAuth callback arrives at
 * denext's `{basePath}/callback/:provider` — or remove them with `undefined`.
 * `backend({ supabase })` calls it at setup.
 *
 * @param handler The options and keys, or `undefined`.
 */
export function installGoTrue(handler: GoTrueHandlerOptions | undefined): void {
  if (!handler) {
    setGoTrueOAuthCallback(undefined);
    return;
  }
  setGoTrueOAuthCallback(oauthRoutes.gotrueOAuthCallback({
    session: (request, config) => {
      const origin = new URL(absoluteUrl(request, "/", { canonicalOrigin: config.canonicalOrigin }))
        .origin;
      return {
        config,
        options: handler.options,
        keys: handler.keys,
        issuer: `${origin}${GOTRUE_PREFIX}`,
      };
    },
  }));
}
