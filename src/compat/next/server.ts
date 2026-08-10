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
  MIDDLEWARE_REWRITE_HEADER,
  setRequestAdapter,
} from "../../server/mod.ts";
import { NextRequest } from "./request.ts";
import { ResponseCookies } from "./cookies.ts";

export { userAgent } from "../../server/mod.ts";
export type { UserAgent } from "../../server/mod.ts";
export { NextRequest } from "./request.ts";
export { NextURL } from "./request.ts";
export type { GeoInfo } from "./request.ts";

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

  /** Continue routing, optionally attaching response headers. */
  static next(init?: { headers?: HeadersInit }): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_NEXT_HEADER, "1");
    return new NextResponse(null, { headers });
  }

  /** Internally route as if the request were for `url` (no client redirect). */
  static rewrite(url: string | URL, init?: { headers?: HeadersInit }): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_REWRITE_HEADER, String(url));
    return new NextResponse(null, { headers });
  }

  /** Redirect the client to `url` (default 307). */
  static override redirect(url: string | URL, init?: number | ResponseInit): NextResponse {
    const status = typeof init === "number" ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === "object" ? init.headers : undefined);
    headers.set("location", String(url));
    return new NextResponse(null, { status, headers });
  }

  /** Respond with JSON. */
  static override json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new NextResponse(JSON.stringify(data), { ...init, headers });
  }
}
