/**
 * `next-auth` (Auth.js v5) on denext. `NextAuth(config)` returns the same four things —
 * `handlers`, `auth`, `signIn`, `signOut` (plus `unstable_update`) — on top of denext's
 * first-party auth: its OAuth / OIDC flow (state + PKCE, + nonce for OIDC), its signed
 * `__Host-` session cookie, its rate limits and its account-linking rules.
 *
 * ```ts
 * // auth.ts
 * import NextAuth from "next-auth";
 * import GitHub from "next-auth/providers/github";
 * export const { handlers, auth, signIn, signOut } = NextAuth({ providers: [GitHub] });
 *
 * // app/api/auth/[...nextauth]/route.ts
 * export const { GET, POST } = handlers;
 *
 * // middleware.ts
 * export { auth as middleware } from "@/auth";
 * ```
 *
 * In production denext needs `AUTH_URL` (its `canonicalOrigin`): it never derives the OAuth
 * `redirect_uri` or its same-origin checks from the `Host` header. What else differs from Auth.js
 * is listed in KNOWN-DIFFERENCES.md.
 *
 * @module
 */

import { NextRequest } from "../next/request.ts";
import { NextResponse } from "../next/server.ts";
import { redirect } from "../../runtime/error-boundary.ts";
import { denextAuth } from "../../server/auth/mod.ts";
import { copyRemoteAddr } from "../../server/remote-addr.ts";
import { translateConfig } from "./config.ts";
import {
  type AuthorizationParamsInput,
  contextRequest,
  runSignIn,
  runSignOut,
  safeAuthorizationParams,
  safeCallbackUrl,
} from "./flows.ts";
import { createHandlers, type RouteHandler } from "./handlers.ts";
import { currentAuthJsSession } from "./session.ts";
import { type ActiveNextAuth, setActiveNextAuth } from "./state.ts";
import type { AuthorizedCallbackParams, NextAuthConfig, Session } from "./types.ts";

export type {
  Account,
  AuthorizedCallbackParams,
  Awaitable,
  CallbacksOptions,
  DefaultSession,
  EventCallbacks,
  JwtCallbackParams,
  LoggerInstance,
  NextAuthConfig,
  Profile,
  Provider,
  Session,
  SessionCallbackParams,
  SignInCallbackParams,
  User,
} from "./types.ts";
export type {
  AuthJsAdapter as Adapter,
  AuthJsAdapterAccount as AdapterAccount,
  AuthJsAdapterSession as AdapterSession,
  AuthJsAdapterUser as AdapterUser,
  AuthJsVerificationToken as VerificationToken,
} from "./adapter.ts";
export type { RouteHandler } from "./handlers.ts";
export type { NextRequest } from "../next/request.ts";

/** The base of every error the Auth.js surface throws; `type` names which. */
export class AuthError extends Error {
  /** The Auth.js error type (`"CredentialsSignin"`, `"AccessDenied"`, …). */
  type: string;

  /**
   * An Auth.js error.
   *
   * @param message What went wrong.
   * @param type The Auth.js error type.
   */
  constructor(message = "Authentication failed", type = "AuthError") {
    super(message);
    this.name = type;
    this.type = type;
  }
}

/** A Credentials sign-in was refused (a wrong password, a refused `authorize`, a rate limit). */
export class CredentialsSignin extends AuthError {
  /** A code an app may set on a subclass; denext reports `"credentials"`. */
  code = "credentials";

  /**
   * A refused Credentials sign-in.
   *
   * @param message What went wrong.
   */
  constructor(message = "Sign in failed") {
    super(message, "CredentialsSignin");
  }
}

/** `callbacks.signIn` (or a ban) refused a sign-in. */
export class AccessDenied extends AuthError {
  /**
   * A refused sign-in.
   *
   * @param message What went wrong.
   */
  constructor(message = "Access denied") {
    super(message, "AccessDenied");
  }
}

/** The config can't work (a missing secret, an unknown provider). */
export class Configuration extends AuthError {
  /**
   * A configuration error.
   *
   * @param message What went wrong.
   */
  constructor(message = "Server configuration error") {
    super(message, "Configuration");
  }
}

/** What a request handed to `auth(handler)` carries. */
export type NextAuthRequest = NextRequest & { auth: Session | null };

/** A middleware / route handler `auth(handler)` wraps. */
export type AuthHandler = (
  request: NextAuthRequest,
  context: unknown,
) => Response | void | undefined | Promise<Response | void | undefined>;

/** `auth`: read the session, wrap a handler, or run as middleware. */
export interface AuthFunction {
  /** The current session (Server Components, route handlers, Server Actions), or `null`. */
  (): Promise<Session | null>;
  /** Wrap a middleware or route handler: `request.auth` carries the session. */
  (handler: AuthHandler): (request: Request, context?: unknown) => Promise<Response>;
  /** Run as `middleware.ts`: `callbacks.authorized` decides, else every request continues. */
  (request: Request, context?: unknown): Promise<Response>;
}

/** Options for the server-side {@linkcode NextAuthResult.signIn}. */
export interface SignInOptions extends Record<string, unknown> {
  /** Where to land afterwards (kept same-origin). */
  redirectTo?: string;
  /** `false` returns the URL instead of redirecting. */
  redirect?: boolean;
}

/** Options for the server-side {@linkcode NextAuthResult.signOut}. */
export interface SignOutOptions {
  /** Where to land afterwards (kept same-origin). */
  redirectTo?: string;
  /** `false` returns the URL instead of redirecting. */
  redirect?: boolean;
}

/** What `NextAuth()` returns. */
export interface NextAuthResult {
  /** `export const { GET, POST } = handlers` in `app/api/auth/[...nextauth]/route.ts`. */
  handlers: { GET: RouteHandler; POST: RouteHandler };
  /** Read the session, or guard a handler / middleware. */
  auth: AuthFunction;
  /**
   * Sign in from a Server Action: a Credentials or email provider with the submitted fields, an
   * OAuth provider by redirecting to it. Redirects unless `redirect: false` (which returns the
   * URL); a refused Credentials sign-in throws {@linkcode CredentialsSignin}.
   * `authorizationParams` (`{ prompt: "login" }`, `login_hint`, `scope`, …) are added to an
   * OAuth / OIDC provider's authorization URL, except the ones the flow owns (`state`, PKCE,
   * `nonce`, `redirect_uri`, `client_id`, `response_type`, `response_mode`, request objects).
   */
  signIn: (
    provider?: string,
    options?: FormData | SignInOptions,
    authorizationParams?: AuthorizationParamsInput,
  ) => Promise<string>;
  /** Sign out from a Server Action, then redirect (or return the URL with `redirect: false`). */
  signOut: (options?: SignOutOptions) => Promise<string>;
  /** `update(data)` from the server: the `jwt` callback runs with `trigger: "update"`. */
  unstable_update: (data: Partial<Session> | Record<string, unknown>) => Promise<Session | null>;
}

/** `request` as a `NextRequest` (one with `nextUrl`), keeping its recorded socket peer. */
function asNextRequest(request: Request): NextRequest {
  if (request instanceof NextRequest) return request;
  const next = new NextRequest(request);
  copyRemoteAddr(request, next);
  return next;
}

/** Where an unauthorized middleware request goes: the sign-in page, with a way back. */
function signInRedirect(active: ActiveNextAuth, request: NextRequest): Response {
  const page = active.denext.pages?.signIn ?? `${active.basePath}/signin`;
  const target = new URL(page, request.url);
  target.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(target);
}

/** `auth(request)` and `auth(handler)(request)`: Auth.js's middleware semantics. */
async function runMiddleware(
  active: ActiveNextAuth,
  request: Request,
  context: unknown,
  handler?: AuthHandler,
): Promise<Response> {
  const next = asNextRequest(request);
  const session = await currentAuthJsSession(active, { persist: true });
  const authorized = active.config.callbacks?.authorized;
  const verdict = authorized
    ? await authorized({ request: next, auth: session } as AuthorizedCallbackParams)
    : true;
  if (verdict instanceof Response) return verdict;
  if (handler) {
    (next as NextAuthRequest).auth = session;
    return (await handler(next as NextAuthRequest, context)) ?? NextResponse.next();
  }
  if (verdict === false) return signInRedirect(active, next);
  return NextResponse.next();
}

/** The `auth` function bound to `active`. */
function authFunction(active: ActiveNextAuth): AuthFunction {
  return ((arg?: Request | AuthHandler, context?: unknown) => {
    if (typeof arg === "function") {
      return (request: Request, ctx?: unknown) => runMiddleware(active, request, ctx, arg);
    }
    if (arg instanceof Request) return runMiddleware(active, arg, context);
    return currentAuthJsSession(active, { persist: false });
  }) as AuthFunction;
}

/** The string fields of a `signIn()` options argument. */
function signInFields(options: FormData | SignInOptions | undefined): Record<string, string> {
  const entries = options instanceof FormData
    ? [...options.entries()]
    : Object.entries(options ?? {});
  const out: Record<string, string> = {};
  for (const [key, value] of entries) if (typeof value === "string") out[key] = value;
  return out;
}

/** Whether a `signIn()` call asked not to redirect (`redirect: false`, or `"false"` in a form). */
function wantsNoRedirect(options: FormData | SignInOptions | undefined): boolean {
  if (options instanceof FormData) return options.get("redirect") === "false";
  return options?.redirect === false;
}

/** Where a server-side sign-in goes: the provider's flow, or the sign-in page without one. */
async function signInUrl(
  active: ActiveNextAuth,
  request: Request,
  providerId: string | undefined,
  fields: Record<string, string>,
  target: string,
  authorizationParams: Record<string, string>,
): Promise<string> {
  const provider = providerId ? active.providers.find((p) => p.id === providerId) : undefined;
  if (!provider) {
    const page = active.denext.pages?.signIn ?? `${active.basePath}/signin`;
    return `${page}?callbackUrl=${encodeURIComponent(target)}`;
  }
  const result = await runSignIn(active, request, provider, fields, target, authorizationParams);
  if (result.error === "CredentialsSignin") throw new CredentialsSignin();
  return result.url;
}

/** The server-side `signIn`. */
function serverSignIn(active: ActiveNextAuth): NextAuthResult["signIn"] {
  return async (providerId, options, authorizationParams) => {
    const request = contextRequest("signIn");
    const { redirectTo, redirect: _redirect, callbackUrl, ...fields } = signInFields(options);
    const requested = redirectTo ?? callbackUrl ?? request.headers.get("referer");
    const target = await safeCallbackUrl(active, request, requested);
    const extra = safeAuthorizationParams(authorizationParams);
    const url = await signInUrl(active, request, providerId, fields, target, extra);
    if (!wantsNoRedirect(options)) redirect(url);
    return url;
  };
}

/** The server-side `signOut`. */
function serverSignOut(active: ActiveNextAuth): NextAuthResult["signOut"] {
  return async (options = {}) => {
    const request = contextRequest("signOut");
    const target = await safeCallbackUrl(active, request, options.redirectTo);
    const { url } = await runSignOut(active, request, target);
    if (options.redirect !== false) redirect(url);
    return url;
  };
}

/**
 * Set up Auth.js on denext.
 *
 * @param config The Auth.js config, or a function returning it (called once, with no request).
 * @returns `{ handlers, auth, signIn, signOut, unstable_update }`.
 */
export default function NextAuth(
  config: NextAuthConfig | ((request: Request | undefined) => NextAuthConfig),
): NextAuthResult {
  const resolved = typeof config === "function" ? config(undefined) : config;
  if (typeof (resolved as { then?: unknown }).then === "function") {
    throw new Configuration(
      "next-auth: a lazy config must return the config itself, not a promise (see " +
        "KNOWN-LIMITATIONS.md)",
    );
  }
  const active = translateConfig(resolved);
  // Validates the translated config (secret, providers, origin) and makes it the one `auth()`
  // reads. The plugin it returns is not needed: the handlers serve the endpoints.
  denextAuth(active.denext);
  setActiveNextAuth(active);
  return {
    handlers: createHandlers(active),
    auth: authFunction(active),
    signIn: serverSignIn(active),
    signOut: serverSignOut(active),
    unstable_update: (data) => currentAuthJsSession(active, { persist: true, update: { data } }),
  };
}
