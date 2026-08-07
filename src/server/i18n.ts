// Internationalized routing with an *optional* default-locale prefix.
//
//   /about      -> the default locale (unprefixed)
//   /fr/about   -> the "fr" locale
//
// The locale is peeled off the pathname at request time (the router core is
// untouched) and merged into the route `params`, so pages, layouts, templates,
// and client hydration all see `params.locale`.

import type { Middleware } from "./middleware.ts";
import { next, redirect } from "./middleware.ts";

/** Internationalization configuration. */
export interface I18nConfig {
  /** All supported locale codes, e.g. `["en", "fr", "de"]`. */
  locales: string[];
  /** The locale served without a URL prefix, e.g. `"en"`. */
  defaultLocale: string;
}

/** The result of peeling a locale prefix off a pathname. */
export interface PeeledLocale {
  /** The resolved locale (the default when the path had no locale prefix). */
  locale: string;
  /** The pathname with any locale prefix removed (used for route matching). */
  rest: string;
}

/**
 * Peel a leading locale segment off `pathname`. If the first path segment is a
 * configured locale it is stripped and returned; otherwise the default locale
 * is used and the pathname is returned unchanged.
 *
 * @param pathname The request pathname (e.g. `/fr/about`).
 * @param i18n The i18n config, or undefined to disable peeling.
 * @returns The resolved locale and the pathname to route with.
 */
export function peelLocale(
  pathname: string,
  i18n: I18nConfig | undefined,
): PeeledLocale {
  if (!i18n) return { locale: "", rest: pathname };
  const parts = pathname.split("/").filter((s) => s.length > 0);
  if (parts.length > 0 && i18n.locales.includes(parts[0])) {
    const rest = "/" + parts.slice(1).join("/");
    return { locale: parts[0], rest };
  }
  return { locale: i18n.defaultLocale, rest: pathname };
}

/** Parse an `Accept-Language` header into an ordered list of locale codes. */
export function parseAcceptLanguage(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .filter((e) => e.tag.length > 0)
    .sort((a, b) => b.q - a.q)
    .map((e) => e.tag);
}

/**
 * Pick the best supported locale for a request from the `NEXT_LOCALE` cookie
 * (highest priority) then the `Accept-Language` header, falling back to the
 * default locale. Matches on both exact tags and the primary subtag (`fr-CA`
 * matches a supported `fr`).
 */
export function detectLocale(request: Request, i18n: I18nConfig): string {
  const supported = new Set(i18n.locales);

  // 1. Explicit cookie preference.
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)NEXT_LOCALE=([^;]+)/.exec(cookie);
  if (match && supported.has(match[1])) return match[1];

  // 2. Accept-Language negotiation.
  for (const tag of parseAcceptLanguage(request.headers.get("accept-language"))) {
    if (supported.has(tag)) return tag;
    const primary = tag.split("-")[0];
    if (supported.has(primary)) return primary;
  }

  return i18n.defaultLocale;
}

/**
 * A middleware entry that redirects an unprefixed request to the visitor's
 * detected locale when it differs from the default. Compose it into the
 * middleware chain to get automatic locale routing:
 *
 * ```ts
 * export default [localeMiddleware({ locales: ["en", "fr"], defaultLocale: "en" })];
 * ```
 *
 * Requests that already carry a locale prefix, or whose detected locale is the
 * default, pass through untouched.
 *
 * @param i18n The i18n config.
 * @returns A {@link Middleware} handler.
 */
export function localeMiddleware(i18n: I18nConfig): Middleware {
  return (request) => {
    const url = new URL(request.url);
    const { locale } = peelLocale(url.pathname, i18n);
    const first = url.pathname.split("/").filter(Boolean)[0];

    // Already locale-prefixed — leave it alone.
    if (first && i18n.locales.includes(first)) return next();

    const detected = detectLocale(request, i18n);
    if (detected === i18n.defaultLocale || detected === locale) return next();

    const dest = `/${detected}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    return redirect(dest);
  };
}
