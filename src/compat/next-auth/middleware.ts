/**
 * `next-auth/middleware` (NextAuth.js v4) on denext: `withAuth` and the default export, which
 * gate a `middleware.ts` on the session's token as v4 does.
 *
 * ```ts
 * // middleware.ts — every matched path needs a session
 * export { default } from "next-auth/middleware";
 * export const config = { matcher: ["/dashboard/:path*"] };
 *
 * // …or with a callback and a middleware of your own
 * import { withAuth } from "next-auth/middleware";
 * export default withAuth(
 *   (req) => console.log(req.nextauth.token?.email),
 *   { callbacks: { authorized: ({ token }) => token?.role === "admin" } },
 * );
 * ```
 *
 * A request is authorized when `callbacks.authorized({ token, req })` says so (by default: when
 * there is a token); otherwise it is redirected to `pages.signIn` (default `/api/auth/signin`)
 * with a same-origin `callbackUrl`. The auth endpoints themselves (`NEXTAUTH_URL`'s path,
 * `/api/auth` by default), the sign-in and error pages, and Next's and denext's own assets are
 * never gated. As in v4, the token is the JWT strategy's: a database session has none.
 *
 * @module
 */

import { NextRequest } from "../next/request.ts";
import { NextResponse } from "../next/server.ts";
import { copyRemoteAddr } from "../../server/remote-addr.ts";
import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../../server/request-context.ts";
import { translateConfig } from "./config.ts";
import { decode, type JWT } from "./jwt.ts";
import { readEnv } from "./providers/shared.ts";
import { type ActiveNextAuth, activeNextAuth } from "./state.ts";
import { sealedSessionToken } from "./token.ts";
import type { Awaitable } from "./types.ts";

/** The request a `withAuth` middleware receives: `req.nextauth.token` is the session's token. */
export type NextRequestWithAuth = NextRequest & { nextauth: { token: JWT | null } };

/** What a middleware may answer: a `Response`, or nothing to continue. */
export type NextMiddlewareResult = Response | null | undefined | void;

/** A middleware `withAuth` wraps. */
export type NextMiddlewareWithAuth = (
  request: NextRequestWithAuth,
  event: unknown,
) => NextMiddlewareResult | Promise<NextMiddlewareResult>;

/** What `callbacks.authorized` receives. */
export interface AuthorizedParams {
  /** The session's token, or `null`. */
  token: JWT | null;
  /** The request being gated. */
  req: NextRequest;
}

/** `withAuth`'s options (v4's `NextAuthMiddlewareOptions`). */
export interface NextAuthMiddlewareOptions {
  /** The pages unauthorized requests and configuration errors go to. */
  pages?: {
    /** The sign-in page (default `/api/auth/signin`). */
    signIn?: string;
    /** The error page (default `/api/auth/error`). */
    error?: string;
  };
  /** The callbacks. */
  callbacks?: {
    /** Whether the request may continue (default: whether there is a token). */
    authorized?: (params: AuthorizedParams) => Awaitable<boolean>;
  };
  /** The secret the token is sealed under (default: the `NextAuth()` config's, `NEXTAUTH_SECRET`). */
  secret?: string;
  /** Accepted for compatibility: denext's token format is fixed (see KNOWN-DIFFERENCES). */
  jwt?: { decode?: unknown };
  /** Accepted for compatibility: denext's cookie names are fixed. */
  cookies?: Record<string, unknown>;
}

/** The middleware `withAuth` returns. */
export type WithAuthMiddleware = (
  request: Request,
  event?: unknown,
) => Promise<NextMiddlewareResult>;

/** Paths never gated: Next's and denext's assets. */
const PUBLIC_PREFIXES = ["/_next", "/_denext", "/favicon.ico"];

/** The auth endpoints' path: `NEXTAUTH_URL`'s (or `AUTH_URL`'s) path, else `/api/auth`. */
function authPath(): string {
  const raw = readEnv("NEXTAUTH_URL") ?? readEnv("AUTH_URL");
  let path = "";
  try {
    path = raw ? new URL(raw).pathname.replace(/\/+$/, "") : "";
  } catch { /* an unparsable URL: the default */ }
  return path || "/api/auth";
}

/** Instances built only to read a token, per secret (no `NextAuth()` has run yet). */
const readers = new Map<string, ActiveNextAuth>();

/**
 * The instance whose sessions the token comes from: the app's `NextAuth()` one, unless the
 * middleware names another secret — else a reader built from the secret alone. `null` without
 * any secret.
 */
function tokenInstance(secret: string | undefined): ActiveNextAuth | null {
  const active = activeNextAuth();
  const own = active && (secret === undefined || [active.secret].flat().includes(secret));
  if (own) return active;
  const key = secret ?? readEnv("NEXTAUTH_SECRET") ?? readEnv("AUTH_SECRET");
  if (!key) return null;
  let reader = readers.get(key);
  if (!reader) readers.set(key, reader = translateConfig({ providers: [], secret: key }));
  return reader;
}

/** The token of the request's session under `active`, or `null`. */
async function tokenOf(active: ActiveNextAuth, request: Request): Promise<JWT | null> {
  const read = async () => {
    const sealed = await sealedSessionToken(active);
    return sealed ? await decode({ token: sealed, secret: active.secret }) : null;
  };
  return currentContext()
    ? await read()
    : await runWithContext(createRequestContext(request), read);
}

/** `request` as a `NextRequest`, keeping its socket peer. */
function asNextRequest(request: Request): NextRequest {
  if (request instanceof NextRequest) return request;
  const next = new NextRequest(request);
  copyRemoteAddr(request, next);
  return next;
}

/** Whether `pathname` is one the middleware never gates. */
function ungated(req: NextRequest, signInPage: string, errorPage: string): boolean {
  const { pathname } = req.nextUrl;
  const basePath = req.nextUrl.basePath ?? "";
  return `${basePath}${pathname}`.startsWith(authPath()) ||
    pathname === signInPage || pathname === errorPage ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** A redirect to `page` on the request's origin (with its base path), `params` added. */
function redirectToPage(req: NextRequest, page: string, params: Record<string, string>): Response {
  const basePath = req.nextUrl.basePath ?? "";
  const target = new URL(`${basePath}${page}`, req.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) target.searchParams.append(key, value);
  return NextResponse.redirect(target);
}

/** The sign-in and error pages a `withAuth` sends a request to (v4's defaults). */
function pagesOf(
  options: NextAuthMiddlewareOptions | undefined,
): { signIn: string; error: string } {
  return {
    signIn: options?.pages?.signIn ?? "/api/auth/signin",
    error: options?.pages?.error ?? "/api/auth/error",
  };
}

/** Whether `callbacks.authorized` (by default: a token) lets the request through. */
async function isAuthorized(
  options: NextAuthMiddlewareOptions | undefined,
  req: NextRequest,
  token: JWT | null,
): Promise<boolean> {
  const authorized = options?.callbacks?.authorized;
  return authorized ? await authorized({ req, token }) : !!token;
}

/** v4's `handleMiddleware`: gate `request`, then hand an authorized one to `onSuccess`. */
async function handleMiddleware(
  request: Request,
  options: NextAuthMiddlewareOptions | undefined,
  onSuccess?: (req: NextRequest, token: JWT | null) => Promise<NextMiddlewareResult>,
): Promise<NextMiddlewareResult> {
  const req = asNextRequest(request);
  const pages = pagesOf(options);
  if (ungated(req, pages.signIn, pages.error)) return undefined;
  const active = tokenInstance(options?.secret);
  if (!active) {
    console.error("[next-auth][error][NO_SECRET] withAuth needs NEXTAUTH_SECRET (or `secret`)");
    return redirectToPage(req, pages.error, { error: "Configuration" });
  }
  const token = await tokenOf(active, req);
  if (await isAuthorized(options, req, token)) return await onSuccess?.(req, token);
  const { pathname, search, basePath } = req.nextUrl;
  return redirectToPage(req, pages.signIn, {
    callbackUrl: `${basePath ?? ""}${pathname}${search}`,
  });
}

/**
 * Gate a middleware on the session, as NextAuth.js v4's `withAuth` does. Call it as the
 * middleware itself (`export { default } from "next-auth/middleware"`), with options
 * (`withAuth({ pages, callbacks })`), or around a middleware of your own (`withAuth(fn,
 * options)`), which runs only for an authorized request and reads `req.nextauth.token`.
 *
 * @param args A request (run as the middleware), options, or a middleware and options.
 * @returns The middleware's answer when called with a request; otherwise the middleware.
 */
export function withAuth(request: Request, event?: unknown): Promise<NextMiddlewareResult>;
/**
 * The middleware with `options`.
 *
 * @param options The pages, callbacks and secret.
 * @returns The middleware.
 */
export function withAuth(options?: NextAuthMiddlewareOptions): WithAuthMiddleware;
/**
 * `middleware`, run only for an authorized request.
 *
 * @param middleware The app's middleware.
 * @param options The pages, callbacks and secret.
 * @returns The middleware.
 */
export function withAuth(
  middleware: NextMiddlewareWithAuth,
  options?: NextAuthMiddlewareOptions,
): WithAuthMiddleware;
export function withAuth(
  first?: Request | NextAuthMiddlewareOptions | NextMiddlewareWithAuth,
  second?: unknown,
): Promise<NextMiddlewareResult> | WithAuthMiddleware {
  if (first instanceof Request) return handleMiddleware(first, undefined);
  if (typeof first === "function") {
    const options = second as NextAuthMiddlewareOptions | undefined;
    return (request, event) =>
      handleMiddleware(request, options, async (req, token) => {
        (req as NextRequestWithAuth).nextauth = { token };
        return await first(req as NextRequestWithAuth, event);
      });
  }
  return (request) => handleMiddleware(request, first);
}

export default withAuth;
