/**
 * `NextRequest` / `NextURL` compat. `NextRequest` wraps a standard `Request`,
 * adding `nextUrl` (a parsed, cloneable URL), `cookies` (a {@link RequestCookies}
 * jar), and best-effort `ip`/`geo` derived from proxy headers.
 *
 * @module
 */

import { currentContext } from "../../server/request-context.ts";
import { remoteAddrOf } from "../../server/remote-addr.ts";
import { RequestCookies } from "./cookies.ts";

/** What a {@link NextURL} needs to know about the app's routing (the request context's). */
interface NextUrlRouting {
  basePath: string;
  locale?: string;
  locales?: readonly string[];
}

/** The first path segment of `pathname` (`"fr"` for `/fr/about`), or `""`. */
function firstSegment(pathname: string): string {
  const start = pathname.startsWith("/") ? 1 : 0;
  const end = pathname.indexOf("/", start);
  return end === -1 ? pathname.slice(start) : pathname.slice(start, end);
}

/**
 * A `URL` with the extras Next code reaches for: `clone()`, a `basePath`, and a
 * `locale`. It is a real `URL` subclass, so `searchParams`, `href`, etc. work as usual.
 *
 * With `i18n` configured, `pathname` is the path WITHOUT its locale prefix, as in Next.js
 * (`/fr/admin` reads `/admin`, with `locale === "fr"`), so a middleware's
 * `nextUrl.pathname.startsWith("/admin")` covers every locale's spelling of the page; `href`
 * and `toString()` keep the prefix. Assigning `pathname` keeps the URL's locale prefix unless
 * the new path names a locale of its own.
 */
export class NextURL extends URL {
  /** Configured base path (empty by default). */
  basePath = "";
  /** Active locale, when locale routing is in use (empty by default). */
  locale = "";
  /** The locale prefix this URL's path carries (`"/fr"`), `""` for none. */
  #prefix = "";
  /** The app's configured locales (empty without `i18n`). */
  #locales: readonly string[] = [];

  /**
   * A `NextURL` for `url` under the app's routing: its base path, and with `i18n` its locale
   * read from the path's prefix (else the request's resolved locale).
   *
   * @param url The absolute URL.
   * @param routing The request's routing facts, if inside a request.
   * @returns The URL.
   */
  static forRouting(url: string | URL, routing: NextUrlRouting | undefined): NextURL {
    const next = new NextURL(url);
    if (!routing) return next;
    next.basePath = routing.basePath;
    next.locale = routing.locale ?? "";
    next.#locales = routing.locales ?? [];
    next.#readPrefix();
    return next;
  }

  /** Re-read the locale prefix from the full path. */
  #readPrefix(): void {
    const first = firstSegment(super.pathname);
    if (first !== "" && this.#locales.includes(first)) {
      this.#prefix = "/" + first;
      this.locale = first;
    } else {
      this.#prefix = "";
    }
  }

  /** The path without its locale prefix (Next's `nextUrl.pathname`). */
  override get pathname(): string {
    const full = super.pathname;
    return this.#prefix ? full.slice(this.#prefix.length) || "/" : full;
  }

  /** Set the path; the URL keeps its locale prefix unless `value` names a locale itself. */
  override set pathname(value: string) {
    const path = String(value);
    if (this.#prefix === "" || this.#locales.includes(firstSegment(path))) {
      super.pathname = path;
      this.#readPrefix();
      return;
    }
    const rest = path.startsWith("/") ? path : "/" + path;
    super.pathname = rest === "/" ? this.#prefix : this.#prefix + rest;
  }

  /** The whole URL, locale prefix included. */
  override get href(): string {
    return super.href;
  }

  /** Replace the whole URL (its locale prefix is read again). */
  override set href(value: string) {
    super.href = value;
    this.#readPrefix();
  }

  /** Return an independent copy of this URL. */
  clone(): NextURL {
    const copy = new NextURL(super.href);
    copy.basePath = this.basePath;
    copy.locale = this.locale;
    copy.#locales = this.#locales;
    copy.#prefix = this.#prefix;
    return copy;
  }
}

/** Approximate geo info (populated from CDN headers when present). */
export interface GeoInfo {
  /** Two-letter country code. */
  country?: string;
  /** Region/state code. */
  region?: string;
  /** City name. */
  city?: string;
  /** Latitude. */
  latitude?: string;
  /** Longitude. */
  longitude?: string;
}

/**
 * `NextRequest` — a `Request` with `nextUrl`, `cookies`, and best-effort
 * `ip`/`geo`. Construct one by wrapping a standard request:
 * `new NextRequest(request)`.
 */
export class NextRequest extends Request {
  /** The request URL, parsed as a {@link NextURL}. */
  readonly nextUrl: NextURL;
  /** Cookies parsed from the `Cookie` header. */
  readonly cookies: RequestCookies;

  /**
   * Wrap a request (or URL) as a `NextRequest`.
   *
   * @param input A URL/string or an existing `Request` to wrap.
   * @param init Optional request init.
   */
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    // Inside the pipeline the resolved basePath / locale are known: expose them like Next
    // (`nextUrl.pathname` is the path without its locale prefix).
    this.nextUrl = NextURL.forRouting(this.url, currentContext()?.routing);
    this.cookies = new RequestCookies(this.headers);
  }

  /**
   * The client IP. The socket peer denext recorded for this request wins (it cannot be
   * spoofed); behind a proxy that is the proxy, so the LAST `x-forwarded-for` hop (the one
   * your own proxy appended) is used next, then `x-real-ip`. Never the first XFF hop —
   * that is whatever the client chose to send.
   */
  get ip(): string | undefined {
    const peer = remoteAddrOf(this);
    if (peer && !isLoopbackOrPrivate(peer)) return peer;
    const fwd = this.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",").map((h) => h.trim()).filter(Boolean).at(-1);
    return this.headers.get("x-real-ip") ?? peer ?? undefined;
  }

  /** Best-effort geo info from common CDN headers (Vercel / Cloudflare). */
  get geo(): GeoInfo {
    const h = this.headers;
    const geo: GeoInfo = {
      country: h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry") ?? undefined,
      region: h.get("x-vercel-ip-country-region") ?? undefined,
      city: h.get("x-vercel-ip-city") ?? undefined,
      latitude: h.get("x-vercel-ip-latitude") ?? undefined,
      longitude: h.get("x-vercel-ip-longitude") ?? undefined,
    };
    return geo;
  }
}

/** Loopback / RFC1918 / link-local peers are a reverse proxy, not the client. */
function isLoopbackOrPrivate(ip: string): boolean {
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i.test(ip);
}
