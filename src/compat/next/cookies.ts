/**
 * `RequestCookies` / `ResponseCookies` — the cookie APIs exposed by
 * `NextRequest.cookies` and `NextResponse.cookies`, backed by `@std/http/cookie`
 * (no npm). Matches the shape Next.js code relies on: `get(name)?.value`,
 * `getAll()`, `has()`, `set()`, `delete()`.
 *
 * @module
 */

import { type Cookie, deleteCookie, getCookies, getSetCookies, setCookie } from "@std/http/cookie";

export type { RequestCookie } from "../../server/request-context.ts";
import type { RequestCookie } from "../../server/request-context.ts";

/** Options accepted by `ResponseCookies.set` / `.delete` (a subset of `Cookie`). */
export interface CookieOptions {
  /** Path scope. */
  path?: string;
  /** Domain scope. */
  domain?: string;
  /** Absolute expiry. */
  expires?: Date | number;
  /** Lifetime in seconds. */
  maxAge?: number;
  /** HTTPS-only. */
  secure?: boolean;
  /** Not exposed to JS. */
  httpOnly?: boolean;
  /** Same-site policy. */
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Read-only cookie jar over a request's `Cookie` header, plus in-memory
 * `set`/`delete` (as Next allows on the request in middleware). Backs
 * `NextRequest.cookies`.
 */
export class RequestCookies {
  #map: Map<string, string>;
  #headers: Headers;

  /**
   * Parse the cookie jar from a request's headers. `set`/`delete`/`clear` write the
   * `Cookie` header back (Next.js semantics), so a downstream reader of the request sees them.
   *
   * @param headers The request headers to read cookies from.
   */
  constructor(headers: Headers) {
    this.#headers = headers;
    this.#map = new Map(Object.entries(getCookies(headers)) as [string, string][]);
  }

  /** Re-serialize the jar onto the `Cookie` header (mutable request headers only). */
  #sync(): void {
    try {
      const value = this.toString();
      if (value) this.#headers.set("cookie", value);
      else this.#headers.delete("cookie");
    } catch { /* immutable headers — the jar stays in-memory only */ }
  }

  /** The jar as a `Cookie` header value. */
  toString(): string {
    return [...this.#map].map(([n, v]) => `${n}=${v}`).join("; ");
  }

  /** Remove every cookie. */
  clear(): this {
    this.#map.clear();
    this.#sync();
    return this;
  }

  /** The cookie named `name`, or `undefined`. */
  get(name: string): RequestCookie | undefined {
    const value = this.#map.get(name);
    return value === undefined ? undefined : { name, value };
  }

  /** All cookies (or all named `name` — 0 or 1 here). */
  getAll(name?: string): RequestCookie[] {
    const all = [...this.#map].map(([name, value]) => ({ name, value }));
    return name === undefined ? all : all.filter((c) => c.name === name);
  }

  /** Whether a cookie named `name` is present. */
  has(name: string): boolean {
    return this.#map.has(name);
  }

  /** Set a cookie on the request jar (`set(name, value)` or `set({ name, value })`). */
  set(name: string | RequestCookie, value?: string): this {
    if (typeof name === "object") this.#map.set(name.name, name.value);
    else this.#map.set(name, value ?? "");
    this.#sync();
    return this;
  }

  /** Delete a cookie (or several) from the request jar; returns whether it existed. */
  delete(name: string | string[]): boolean | boolean[] {
    if (Array.isArray(name)) {
      const out = name.map((n) => this.#map.delete(n));
      this.#sync();
      return out;
    }
    const had = this.#map.delete(name);
    this.#sync();
    return had;
  }

  /** The number of cookies. */
  get size(): number {
    return this.#map.size;
  }

  /** Iterate `[name, cookie]` pairs (Next's RequestCookies is iterable). */
  [Symbol.iterator](): IterableIterator<[string, RequestCookie]> {
    return [...this.#map].map(
      ([name, value]) => [name, { name, value }] as [string, RequestCookie],
    ).values();
  }
}

/**
 * Cookie writer over a response's headers (emits `Set-Cookie`). Backs
 * `NextResponse.cookies`; `set`/`delete` append the appropriate `Set-Cookie`,
 * `get`/`getAll` parse those already staged.
 */
export class ResponseCookies {
  #headers: Headers;

  /**
   * Write cookies onto a response's headers.
   *
   * @param headers The response headers to write `Set-Cookie` onto.
   */
  constructor(headers: Headers) {
    this.#headers = headers;
  }

  /** Stage a `Set-Cookie` for `name`/`value` with optional attributes. */
  set(
    name: string | (Cookie & { name: string }),
    value?: string,
    options: CookieOptions = {},
  ): this {
    const cookie: Cookie = typeof name === "string"
      ? { name, value: value ?? "", ...normalize(options) }
      : name;
    setCookie(this.#headers, cookie);
    return this;
  }

  /** Stage a `Set-Cookie` that expires the cookie `name`. */
  delete(name: string, options: { path?: string; domain?: string } = {}): this {
    deleteCookie(this.#headers, name, options);
    return this;
  }

  /** The staged cookie named `name` (with attributes), or `undefined`. */
  get(name: string): Cookie | undefined {
    return getSetCookies(this.#headers).find((c) => c.name === name);
  }

  /** All staged cookies, with their attributes (path/expires/etc.). */
  getAll(): Cookie[] {
    return getSetCookies(this.#headers);
  }
}

/** Map our option names to `@std/http` `Cookie` fields. */
function normalize(o: CookieOptions): Partial<Cookie> {
  const expires = typeof o.expires === "number" ? new Date(o.expires) : o.expires;
  return {
    path: o.path,
    domain: o.domain,
    expires,
    maxAge: o.maxAge,
    secure: o.secure,
    httpOnly: o.httpOnly,
    sameSite: o.sameSite,
  };
}
