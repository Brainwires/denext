/**
 * `next-intl/middleware` compat — `createMiddleware(routing)` returns a denext
 * middleware handler that detects the locale and prefixes/rewrites/redirects the
 * request per the routing's `localePrefix` strategy.
 *
 * @module
 */

import { NextResponse } from "../next/server.ts";
import type { Middleware } from "../../server/mod.ts";
import {
  defineRouting,
  detectLocale,
  type ResolvedRouting,
  type RoutingConfig,
} from "./routing.ts";

/** Build a `/{locale}{pathname}` target, keeping the query string. */
function localizedUrl(url: URL, locale: string): URL {
  const clean = url.pathname === "/" ? "" : url.pathname;
  return new URL(`/${locale}${clean}${url.search}`, url);
}

/**
 * Create a locale-routing middleware from a routing config.
 *
 * Behavior by prefix mode:
 * - already-prefixed paths continue (setting the locale cookie);
 * - `always` / non-default `as-needed` → redirect to the prefixed URL;
 * - default-locale `as-needed`, and `never` → internal rewrite (no redirect).
 *
 * @param config A routing config or resolved routing.
 * @returns A denext {@link Middleware}.
 */
export function createMiddleware(config: RoutingConfig | ResolvedRouting): Middleware {
  const routing: ResolvedRouting = "localePrefixMode" in config ? config : defineRouting(config);

  return function intlMiddleware(request: Request) {
    const url = new URL(request.url);
    const firstSegment = url.pathname.split("/")[1];

    // Already carries a supported locale → continue, refreshing the cookie.
    if (routing.locales.includes(firstSegment)) {
      const res = NextResponse.next();
      if (routing.cookieName) res.cookies.set(routing.cookieName, firstSegment, { path: "/" });
      return res;
    }

    const locale = detectLocale(request, routing);
    const isDefault = locale === routing.defaultLocale;

    if (routing.localePrefixMode === "never") {
      return NextResponse.rewrite(localizedUrl(url, locale));
    }
    if (routing.localePrefixMode === "as-needed" && isDefault) {
      return NextResponse.rewrite(localizedUrl(url, locale));
    }

    // "always", or "as-needed" for a non-default locale → visible redirect.
    const res = NextResponse.redirect(localizedUrl(url, locale));
    if (routing.cookieName) res.cookies.set(routing.cookieName, locale, { path: "/" });
    return res;
  };
}
