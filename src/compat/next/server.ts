/**
 * `next/server` compat — `NextRequest`, `NextResponse`, and `userAgent`.
 *
 * `NextResponse` is a real `Response` subclass with a `.cookies` writer; its
 * statics (`next`/`rewrite`/`redirect`/`json`) return responses the denext
 * middleware runner understands (via Next's `x-middleware-*` header protocol),
 * so you can write Next-style middleware:
 *
 * ```ts
 * export function middleware(req: NextRequest) {
 *   const res = NextResponse.next();
 *   res.cookies.set("seen", "1");
 *   return res;
 * }
 * ```
 *
 * Importing this module registers a request adapter so middleware handlers
 * receive a `NextRequest` (with `nextUrl`/`cookies`).
 *
 * @module
 */

import {
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_OVERRIDE_HEADER,
  MIDDLEWARE_REQUEST_PREFIX,
  MIDDLEWARE_REWRITE_HEADER,
  setRequestAdapter,
} from "../../server/mod.ts";
import { NextRequest } from "./request.ts";
import { ResponseCookies } from "./cookies.ts";

export { RequestCookies, ResponseCookies } from "./cookies.ts";
export type { CookieOptions, RequestCookie } from "./cookies.ts";

export { userAgent, userAgentFromString } from "../../server/mod.ts";
export type { UserAgent } from "../../server/mod.ts";
// `next/server` also re-exports the OG image renderer.
export { ImageResponse } from "../../server/mod.ts";
export type { ImageResponseOptions } from "../../server/mod.ts";
// Request lifecycle helpers Next ships from `next/server`: `after()` schedules
// post-response work; `connection()` marks the render dynamic.
export { after, connection } from "../../server/mod.ts";
export { NextRequest } from "./request.ts";
export { NextURL } from "./request.ts";
export type { GeoInfo } from "./request.ts";

/**
 * `URLPattern` — Next re-exports the platform `URLPattern` from `next/server`. Deno
 * provides it natively, so denext re-exposes the global under the same name.
 */
export const URLPattern: typeof globalThis.URLPattern = globalThis.URLPattern;

/**
 * `NextFetchEvent` — the event object passed to Edge middleware. denext runs middleware
 * on Deno (not the Edge runtime), so this is a thin shell exposing `sourcePage` and
 * `waitUntil` (post-response work is scheduled via denext's {@link after}).
 */
export class NextFetchEvent {
  /** The route path the middleware is running for. */
  readonly sourcePage: string;
  /** The request that triggered the event. */
  readonly request: Request;
  /** Create a fetch event for `request` (optionally tagged with its `sourcePage`). */
  constructor(params: { request: Request; sourcePage?: string }) {
    this.request = params.request;
    this.sourcePage = params.sourcePage ?? "/";
  }
  /**
   * Keep the runtime alive for `promise` after the response is sent (best-effort;
   * denext awaits it via its post-response scheduler).
   */
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch(() => {});
  }
}

// Middleware handlers receive a NextRequest (nextUrl/cookies) once this module
// is imported. We wrap a *clone* so constructing the NextRequest doesn't consume
// the original request's body — the runner still routes the original downstream
// to the page/route/Server-Action handler, which must be able to read it.
// Idempotent: identity for anything already a NextRequest.
setRequestAdapter((r) => (r instanceof NextRequest ? r : new NextRequest(r.clone())));

/**
 * `NextResponse` — a `Response` with a cookie writer. Use its statics from a
 * `middleware.ts`/`proxy.ts` handler, or construct one directly to reply.
 */
export class NextResponse extends Response {
  #cookies: ResponseCookies | undefined;

  /** A `Set-Cookie` writer over this response's headers. */
  get cookies(): ResponseCookies {
    if (!this.#cookies) this.#cookies = new ResponseCookies(this.headers);
    return this.#cookies;
  }

  /**
   * Continue routing, optionally attaching response headers and/or overriding the
   * request headers the downstream route/handler sees
   * (`next({ request: { headers } })`).
   */
  static next(init?: { headers?: HeadersInit; request?: { headers: Headers } }): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_NEXT_HEADER, "1");
    if (init?.request?.headers) encodeRequestHeaders(headers, init.request.headers);
    return new NextResponse(null, { headers });
  }

  /** Internally route as if the request were for `url` (no client redirect). */
  static rewrite(url: string | URL, init?: { headers?: HeadersInit }): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_REWRITE_HEADER, String(url));
    return new NextResponse(null, { headers });
  }

  /**
   * Redirect the client to `url` (default 307). Like Next, `url` must be
   * absolute — a relative string throws (build it against `req.nextUrl`).
   */
  static override redirect(url: string | URL, init?: number | ResponseInit): NextResponse {
    // Throws on a non-absolute URL, matching Next.js's NextResponse.redirect.
    const absolute = new URL(url);
    const status = typeof init === "number" ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === "object" ? init.headers : undefined);
    headers.set("location", absolute.href);
    return new NextResponse(null, { status, headers });
  }

  /** Respond with JSON. */
  static override json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new NextResponse(JSON.stringify(data), { ...init, headers });
  }
}

/**
 * Encode `requestHeaders` onto `responseHeaders` using Next's request-override
 * wire format, so the middleware runner can apply them to the forwarded request.
 */
function encodeRequestHeaders(responseHeaders: Headers, requestHeaders: Headers): void {
  const names: string[] = [];
  for (const [name, value] of requestHeaders) {
    responseHeaders.set(`${MIDDLEWARE_REQUEST_PREFIX}${name}`, value);
    names.push(name);
  }
  responseHeaders.set(MIDDLEWARE_OVERRIDE_HEADER, names.join(","));
}
