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
import { handleAuthRequest } from "./routes.ts";
import { readAuthSession } from "./session.ts";
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
  if (!config.providers || config.providers.length === 0) {
    throw new Error("denextAuth: at least one provider is required");
  }
  const seen = new Set<string>();
  for (const p of config.providers) {
    if (seen.has(p.id)) throw new Error(`denextAuth: duplicate provider id "${p.id}"`);
    seen.add(p.id);
    // Fail fast on empty OAuth credentials. A missing `Deno.env.get("…")!` coerces to
    // the string "undefined", which would otherwise be POSTed to the token endpoint
    // and fail every login at runtime with an opaque `?error=oauth_failed` and no boot
    // signal. Catch it here, at config time, with an actionable message.
    if (isOAuthProvider(p)) {
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
  }
  if (!config.canonicalOrigin) {
    // Required in production: without it the OAuth redirect_uri and the same-origin
    // checks fall back to the attacker-controllable Host header. Detected via the
    // standard NODE_ENV/DENEXT_ENV=production signal a deploy sets.
    const isProd = Deno.env.get("NODE_ENV") === "production" ||
      Deno.env.get("DENEXT_ENV") === "production";
    if (isProd) {
      throw new Error(
        "denextAuth: `canonicalOrigin` is required in production — without it the OAuth " +
          "redirect_uri and same-origin checks derive from the attacker-controllable Host " +
          'header. Set it, e.g. canonicalOrigin: "https://app.example.com".',
      );
    }
    if (!warnedNoOrigin) {
      warnedNoOrigin = true;
      console.warn(
        "denextAuth: no `canonicalOrigin` set — the OAuth redirect_uri is derived from the " +
          "Host header, which is attacker-controllable. Set it in production.",
      );
    }
  }
  if (config.dangerouslyAllowInsecureProviders) {
    console.warn(
      "denextAuth: `dangerouslyAllowInsecureProviders` is on — localhost/insecure providers " +
        "are permitted. Never enable this in production.",
    );
  }
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
    },
  };
}

/**
 * Read the current request's auth session, or `null` when signed out. Call from a
 * Server Component, a `route.ts` handler, or `middleware.ts` — anywhere inside the
 * request context.
 *
 * @returns The {@link AuthSession}, or `null`.
 */
export function auth(): Promise<AuthSession | null> {
  if (!activeConfig) return Promise.resolve(null);
  return readAuthSession(activeConfig);
}

/** Options for {@link requireAuth}. */
export interface RequireAuthOptions {
  /** Where to send unauthenticated users (default: the config `pages.signIn` or `/`). */
  signInPath?: string;
}

/**
 * Middleware guard: allow the request through when signed in, otherwise return a
 * redirect to the sign-in page carrying a `callbackUrl` back to the target. Use in
 * `middleware.ts` (matcher-gated):
 * ```ts
 * export async function middleware(request: Request) {
 *   return await requireAuth(request); // returns a Response to redirect, or null to continue
 * }
 * export const config = { matcher: ["/dashboard/:path*"] };
 * ```
 *
 * @param request The incoming request.
 * @param options Optional sign-in path override.
 * @returns A redirect `Response` when unauthenticated, or `null` to continue.
 */
export async function requireAuth(
  request: Request,
  options: RequireAuthOptions = {},
): Promise<Response | null> {
  const session = await auth();
  if (session) return null;
  const url = new URL(request.url);
  const signIn = options.signInPath ?? activeConfig?.pages?.signIn ?? "/";
  const target = safeRedirectLocation(
    `${signIn}?callbackUrl=${encodeURIComponent(url.pathname + url.search)}`,
  );
  return new Response(null, { status: 302, headers: { location: target } });
}

export type {
  AuthCallbacks,
  AuthConfig,
  AuthProvider,
  AuthSession,
  AuthUser,
  CredentialsProvider,
  OAuthProvider,
} from "./types.ts";
export { credentials, github, google, oidc } from "./providers.ts";
export type { CredentialsOptions, OAuthClientOptions, OidcOptions } from "./providers.ts";
