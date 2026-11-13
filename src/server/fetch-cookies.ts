/**
 * Cookie sessions for denext's server-side fetches (`safeFetch({ cookieJar })`, the OAuth
 * back-channel calls) and `denext/testing`'s client: the jar shape they take, and the runtime's
 * own RFC 6265bis jar where the process has it.
 *
 * denext's Deno carries `Deno.CookieJar` behind `--unstable-cookies` (or `"unstable":
 * ["cookies"]` in deno.json): host-only and domain cookies, path matching, `Max-Age` /
 * `Expires`, `Secure` only over https or loopback, the `__Secure-` / `__Host-` prefixes, and a
 * `Domain=` no wider than the host's registrable domain (a pinned Public Suffix List). Without the
 * flag, and on stock Deno, the name is absent; {@linkcode runtimeCookieJar} then answers null and
 * the callers keep their behaviour without one.
 *
 * @module
 */

/**
 * A cookie jar a fetch session stores responses' cookies in and reads requests' cookies from:
 * the shape of the runtime's `Deno.CookieJar` (any object with these two methods works).
 */
export interface FetchCookieJar {
  /** The `Cookie` header value for a request to `url`, or `null` when no cookie matches. */
  getCookieString(url: string | URL): string | null;
  /**
   * Store one `Set-Cookie` value as received from `url`. A cookie the jar refuses may throw;
   * the callers drop it, as a browser does.
   */
  setCookie(setCookie: string, url: string | URL): void;
}

/** The runtime's jar, as {@linkcode runtimeCookieJar} hands it out. */
export interface RuntimeCookieJar extends FetchCookieJar, Disposable {
  /** The cookies sent to `url`, or every cookie with no URL. */
  getCookies(url?: string | URL): { name: string; value: string }[];
  /** Remove every cookie. */
  clear(): void;
  /** Release the jar. */
  close(): void;
}

/** The runtime's `Deno.CookieJar` constructor, when this process has it. */
function cookieJarClass(): (new () => RuntimeCookieJar) | null {
  const ctor = (globalThis as { Deno?: { CookieJar?: unknown } }).Deno?.CookieJar;
  return typeof ctor === "function" ? ctor as new () => RuntimeCookieJar : null;
}

/**
 * A new runtime cookie jar (`Deno.CookieJar`), or `null` where the process has none (stock Deno,
 * or denext's Deno without `--unstable-cookies`). Dispose of it (`using`) when the session ends:
 * it holds a runtime resource.
 *
 * @returns The jar, or null.
 */
export function runtimeCookieJar(): RuntimeCookieJar | null {
  const Jar = cookieJarClass();
  return Jar ? new Jar() : null;
}

/**
 * Store every `Set-Cookie` of a response from `url` in `jar`; a cookie the jar refuses (a
 * `Domain=` another site's, a `Secure` one over plain http) is dropped.
 *
 * @param jar The session's jar.
 * @param headers The response's headers.
 * @param url Where the response came from.
 */
export function storeResponseCookies(
  jar: FetchCookieJar,
  headers: Headers,
  url: string | URL,
): void {
  for (const line of headers.getSetCookie()) {
    try {
      jar.setCookie(line, url);
    } catch { /* refused by the jar's rules, or the jar is closed */ }
  }
}

/**
 * Add `jar`'s cookies for `url` to `headers`, unless the request sets its own `Cookie` header
 * (an explicit header bypasses the jar, as the runtime's fetch does).
 *
 * @param jar The session's jar.
 * @param headers The request's headers (changed in place).
 * @param url Where the request goes.
 */
export function addRequestCookies(jar: FetchCookieJar, headers: Headers, url: string | URL): void {
  if (headers.has("cookie")) return;
  let value: string | null = null;
  try {
    value = jar.getCookieString(url);
  } catch { /* a closed jar (a background call after its session ended) sends none */ }
  if (value) headers.set("cookie", value);
}
