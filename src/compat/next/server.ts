/**
 * `next/server` compat — a `NextResponse`-shaped helper whose statics map to
 * denext's middleware commands, plus `userAgent`. Return `NextResponse.next()` /
 * `.redirect()` / `.rewrite()` from a denext `middleware.ts` / `proxy.ts` handler.
 *
 * @module
 */

import { next as mwNext, rewrite as mwRewrite } from "../../server/mod.ts";
import type { NextCommand, RewriteCommand } from "../../server/mod.ts";

export { userAgent } from "../../server/mod.ts";
export type { UserAgent } from "../../server/mod.ts";

/** `NextRequest` — denext middleware receives the standard `Request`. */
export type NextRequest = Request;

/** The `NextResponse` surface (a subset mapping to denext middleware returns). */
export interface NextResponseApi {
  /** Continue routing, optionally attaching response headers. */
  next(init?: { headers?: HeadersInit }): NextCommand;
  /** Redirect the client to `url` (default 307). */
  redirect(url: string | URL, status?: number): Response;
  /** Internally rewrite — route as if the request were for `url`. */
  rewrite(url: string | URL, init?: { headers?: HeadersInit }): RewriteCommand;
  /** Respond with JSON. */
  json(data: unknown, init?: ResponseInit): Response;
}

/**
 * `NextResponse` compat. Its statics return denext middleware commands: `next()`
 * continues routing, `rewrite()` routes internally, `redirect()`/`json()` return
 * a `Response`. Return the result from your middleware handler.
 */
export const NextResponse: NextResponseApi = {
  next(init) {
    return mwNext(init);
  },
  redirect(url, status = 307) {
    return new Response(null, { status, headers: { location: String(url) } });
  },
  rewrite(url, init) {
    return mwRewrite(String(url), init);
  },
  json(data, init) {
    return Response.json(data, init);
  },
};
