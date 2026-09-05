/**
 * `NextRequest` / `NextURL` compat. `NextRequest` wraps a standard `Request`,
 * adding `nextUrl` (a parsed, cloneable URL), `cookies` (a {@link RequestCookies}
 * jar), and best-effort `ip`/`geo` derived from proxy headers.
 *
 * @module
 */

import { remoteAddrOf } from "../../server/remote-addr.ts";
import { RequestCookies } from "./cookies.ts";

/**
 * A `URL` with the extras Next code reaches for: `clone()`, a `basePath`, and a
 * `locale` slot. It is a real `URL` subclass, so `pathname`, `searchParams`,
 * etc. work as usual.
 */
export class NextURL extends URL {
  /** Configured base path (empty by default). */
  basePath = "";
  /** Active locale, when locale routing is in use (empty by default). */
  locale = "";

  /** Return an independent copy of this URL. */
  clone(): NextURL {
    const copy = new NextURL(this.href);
    copy.basePath = this.basePath;
    copy.locale = this.locale;
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
    this.nextUrl = new NextURL(this.url);
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
