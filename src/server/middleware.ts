// Root middleware support (Next.js-style `middleware.ts`, with `proxy.ts` as an
// accepted alias). The middleware runs before routing and may short-circuit
// with a Response, redirect, rewrite the URL used for routing, or continue
// (optionally injecting response headers).

import { safeRedirectLocation } from "./config.ts";
import { after } from "./request-context.ts";

/** Internal marker symbol keying a {@linkcode NextCommand}. */
export const NEXT: unique symbol = Symbol.for("denext.middleware.next");
/** Internal marker symbol keying a {@linkcode RewriteCommand}. */
export const REWRITE: unique symbol = Symbol.for("denext.middleware.rewrite");

/**
 * Response headers encoding a middleware intent, matching Next.js's own wire
 * protocol. A `NextResponse.next()` carries {@linkcode MIDDLEWARE_NEXT_HEADER};
 * a `NextResponse.rewrite(url)` carries {@linkcode MIDDLEWARE_REWRITE_HEADER}.
 * The runner reads these so a returned `NextResponse` (a real `Response`
 * subclass) continues/rewrites routing instead of short-circuiting.
 */
export const MIDDLEWARE_NEXT_HEADER = "x-middleware-next";
/** See {@linkcode MIDDLEWARE_NEXT_HEADER}. Value is the rewrite destination. */
export const MIDDLEWARE_REWRITE_HEADER = "x-middleware-rewrite";
/**
 * Comma-separated list of request-header names a middleware overrides via
 * `NextResponse.next({ request: { headers } })`; each value is carried in an
 * `x-middleware-request-<name>` header (see {@linkcode MIDDLEWARE_REQUEST_PREFIX}).
 * The runner applies these to the request forwarded downstream.
 */
export const MIDDLEWARE_OVERRIDE_HEADER = "x-middleware-override-headers";
/** Prefix carrying one overridden request-header value. */
export const MIDDLEWARE_REQUEST_PREFIX = "x-middleware-request-";

/**
 * Optional adapter applied to the request before each handler runs. The compat
 * layer registers one (via {@linkcode setRequestAdapter}) that wraps the
 * `Request` in a `NextRequest`; by default it is the identity.
 */
let requestAdapter: (request: Request) => Request = (r) => r;

/**
 * Install a request adapter (e.g. to hand middleware a `NextRequest`). Importing
 * `next/server` registers one; pass the identity to reset.
 *
 * @param adapter Wraps the request before it reaches a handler.
 */
export function setRequestAdapter(adapter: (request: Request) => Request): void {
  requestAdapter = adapter;
}

/** Apply the installed request adapter (identity unless `next/server` registered one). */
export function adaptRequest(request: Request): Request {
  return requestAdapter(request);
}

/** Extra context passed to a middleware handler alongside the request. */
export interface MiddlewareContext {
  /** The request URL, pre-parsed for convenience. */
  url: URL;
  /**
   * Keep the request alive until `promise` settles without delaying the response
   * (Next.js `NextFetchEvent.waitUntil`). Runs through the same deferred queue as `after()`.
   */
  waitUntil(promise: Promise<unknown>): void;
}

/** Command returned by {@linkcode next} to continue routing, optionally adding headers. */
export interface NextCommand {
  /** Internal marker identifying a "next" command. */
  [NEXT]: true;
  /** Headers to attach to the eventual response. */
  headers?: HeadersInit;
}

/** Command returned by {@linkcode rewrite} to route as if the URL were `destination`. */
export interface RewriteCommand {
  /** Internal marker identifying a "rewrite" command. */
  [REWRITE]: true;
  /** The URL to route as, without issuing a client redirect. */
  destination: string;
  /** Headers to attach to the eventual response. */
  headers?: HeadersInit;
}

/** Anything a middleware handler may return: a response, a command, or nothing. */
export type MiddlewareResult =
  | Response
  | NextCommand
  | RewriteCommand
  | void
  | undefined;

/** A root middleware handler run before routing. */
export type Middleware = (
  request: Request,
  context: MiddlewareContext,
) => MiddlewareResult | Promise<MiddlewareResult>;

/**
 * Next's object form of a matcher entry. `source` is the path pattern; `has`/`missing`
 * (header/cookie/query conditions) are accepted for compatibility but NOT evaluated —
 * the middleware runs for every request `source` matches, which is the safe direction
 * (it never runs less often than Next would).
 */
export interface MatcherEntry {
  /** The path pattern (same syntax as a string matcher). */
  source: string;
  /** Ignored (accepted for Next compatibility). */
  has?: unknown[];
  /** Ignored (accepted for Next compatibility). */
  missing?: unknown[];
}

/** Optional configuration exported by a middleware module. */
export interface MiddlewareConfig {
  /**
   * Path pattern(s) the middleware applies to. Omit to run on every request. Syntax:
   * `:param` (one segment), `:param*` (zero or more — `/dashboard/:path*` also matches
   * `/dashboard`), `:param+` (one or more), `:param?` (optional), a custom pattern
   * `:id(\\d+)`, an unnamed group `((?!api|_next).*)`, and a bare `*`. A trailing slash is
   * always optional.
   */
  matcher?: string | MatcherEntry | (string | MatcherEntry)[];
}

/** A single ordered middleware entry: a handler plus optional per-entry matcher. */
export interface MiddlewareEntry {
  /** The handler to run for this entry. */
  handler: Middleware;
  /** Optional matcher gating this entry (independent of the module matcher). */
  config?: MiddlewareConfig;
}

/**
 * What a `middleware.ts`/`proxy.ts` module may export: a single handler, or an
 * ordered array of handlers/entries that run in sequence (a composed chain).
 */
export type MiddlewareExport =
  | Middleware
  | Array<Middleware | MiddlewareEntry>;

/** Shape of a `middleware.ts`/`proxy.ts` module. */
export interface MiddlewareModule {
  /** The middleware export when exported as the default. */
  default?: MiddlewareExport;
  /** The middleware export when exported as `middleware`. */
  middleware?: MiddlewareExport;
  /** Optional matcher configuration gating the whole chain. */
  config?: MiddlewareConfig;
}

/** Continue to routing; optionally attach headers to the eventual response. */
export function next(init?: { headers?: HeadersInit }): NextCommand {
  return { [NEXT]: true, headers: init?.headers };
}

/** Internally route as if the request were for `destination` (no client redirect). */
export function rewrite(
  destination: string,
  init?: { headers?: HeadersInit },
): RewriteCommand {
  return { [REWRITE]: true, destination, headers: init?.headers };
}

/**
 * Return a client redirect response.
 *
 * The `location` is normalized through {@linkcode safeRedirectLocation}: an
 * explicit `http(s)://` absolute URL is preserved (intentional external
 * redirects), but a protocol-relative escape (`//evil`, `/\evil`) is collapsed to
 * a same-origin path — so a user-controlled value (e.g. a `?next=` param) cannot
 * turn this into an open redirect. Prefer an allowlist for fully untrusted hosts.
 *
 * @param location The redirect target.
 * @param status The redirect status code (default 307).
 */
export function redirectResponse(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location: safeRedirectLocation(location) } });
}

/**
 * @deprecated Renamed {@linkcode redirectResponse} in 2.0 — `redirect` on `denext/server`
 * collided with the throwing `redirect()` from `denext` (Server/Client Components). This
 * alias stays through 2.x and is removed in 3.0.
 */
export const redirect: typeof redirectResponse = redirectResponse;

// ---- Runner ----------------------------------------------------------------

/** The normalized result of running the middleware runner for a request. */
export type MiddlewareOutcome =
  | { type: "response"; response: Response }
  | {
    type: "rewrite";
    url: string;
    headers?: Headers;
    requestHeaders?: Headers;
    /** The request to route (URL + request-header overrides already applied). */
    request?: Request;
    /** The rewrite points at another origin (Next proxies it; denext does too, via safeFetch). */
    external?: boolean;
  }
  | {
    type: "next";
    headers?: Headers;
    requestHeaders?: Headers;
    /** The request to route (request-header overrides already applied). */
    request?: Request;
  };

/**
 * A resolved, request-ready middleware runner (null when there is none). `matchPath` is the
 * pathname matchers are evaluated against when it differs from the request's (an i18n
 * locale prefix stripped, as Next does before running middleware).
 */
export type MiddlewareRunner =
  | ((request: Request, matchPath?: string) => Promise<MiddlewareOutcome>)
  | null;

/**
 * Extract the headers a `NextResponse.next()`/`.rewrite()` wants attached to the
 * eventual response: everything except the intent markers, with `Set-Cookie`
 * preserved as separate entries. Returns `undefined` when there are none.
 */
function passthroughHeaders(source: Headers): Headers | undefined {
  const out = new Headers();
  let any = false;
  for (const cookie of source.getSetCookie()) {
    out.append("set-cookie", cookie);
    any = true;
  }
  for (const [k, v] of source) {
    if (
      k === MIDDLEWARE_NEXT_HEADER || k === MIDDLEWARE_REWRITE_HEADER ||
      k === MIDDLEWARE_OVERRIDE_HEADER || k.startsWith(MIDDLEWARE_REQUEST_PREFIX) ||
      k === "set-cookie"
    ) {
      continue; // intent/request-override markers must not leak to the client
    }
    out.set(k, v);
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Decode the request-header overrides a `NextResponse.next({ request })` staged
 * on its response, into a Headers set to apply to the forwarded request.
 * Returns `undefined` when none were staged.
 */
function decodeRequestHeaders(source: Headers): Headers | undefined {
  const list = source.get(MIDDLEWARE_OVERRIDE_HEADER);
  if (!list) return undefined;
  const out = new Headers();
  for (const name of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    const value = source.get(`${MIDDLEWARE_REQUEST_PREFIX}${name}`);
    if (value !== null) out.set(name, value);
  }
  return out;
}

function isNext(v: unknown): v is NextCommand {
  return typeof v === "object" && v !== null && NEXT in v;
}
function isRewrite(v: unknown): v is RewriteCommand {
  return typeof v === "object" && v !== null && REWRITE in v;
}

/**
 * Compile a matcher pattern into a RegExp with Next.js (path-to-regexp) semantics:
 * `:name`, `:name*` / `+` / `?`, a custom pattern `:name(\\d+)`, an unnamed group
 * `((?!api|_next).*)` (the canonical Next "everything except" matcher), and a bare `*`.
 * Like path-to-regexp's non-strict mode an optional trailing slash always matches, so a
 * guard on `/dashboard` also covers `/dashboard/` — the router resolves both to the same
 * page, and a matcher that missed one spelling would be an auth bypass.
 */
export function matcherToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const step = pattern[i] === ":" ? paramToken(pattern, i + 1, re) : literalToken(pattern, i, re);
    re = step.re;
    i = step.i;
  }
  return new RegExp(`^${re}/?$`);
}

/** A compile step: the pattern so far and the index to continue from. */
interface MatcherStep {
  re: string;
  i: number;
}

/** `:name`, an optional custom `(pattern)`, and an optional `*`/`+`/`?` modifier. */
function paramToken(pattern: string, i: number, re: string): MatcherStep {
  while (i < pattern.length && /[A-Za-z0-9_]/.test(pattern[i])) i++;
  const group = readGroup(pattern, i);
  if (group) i += group.length + 2;
  const modifier = pattern[i];
  if (modifier === "*" || modifier === "+" || modifier === "?") i++;
  return { re: paramRegExp(re, modifier, group ?? "[^/]+"), i };
}

/** A backslash escape, an unnamed `(group)`, a bare `*`, or one literal character. */
function literalToken(pattern: string, i: number, re: string): MatcherStep {
  const ch = pattern[i];
  if (ch === "\\" && i + 1 < pattern.length) {
    // A backslash escapes the next character (`\\(` is a literal paren, not a group).
    return { re: re + escapeRegExp(pattern[i + 1]), i: i + 2 };
  }
  if (ch === "(") {
    const group = readGroup(pattern, i);
    if (group === null) throw new Error(`middleware matcher: unbalanced "(" in ${pattern}`);
    return { re: `${re}(?:${group})`, i: i + group.length + 2 };
  }
  if (ch === "*") return { re: re + ".*", i: i + 1 };
  return { re: re + escapeRegExp(ch), i: i + 1 };
}

const escapeRegExp = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body of a parenthesized `(...)` group starting at `pattern[i]`, or `null` when
 * `pattern[i]` is not `(` or the group is unbalanced. Groups nest (`((?!a).*)`).
 */
function readGroup(pattern: string, i: number): string | null {
  if (pattern[i] !== "(") return null;
  let depth = 0;
  for (let j = i; j < pattern.length; j++) {
    if (pattern[j] === "\\") j++;
    else if (pattern[j] === "(") depth++;
    else if (pattern[j] === ")" && --depth === 0) return pattern.slice(i + 1, j);
  }
  return null;
}

/**
 * Append one `:param` (with its path-to-regexp modifier and segment pattern `seg`,
 * `[^/]+` unless the param carries a custom `(...)`) to the pattern built so far.
 * `:path*` and `:path?` make the segment — and the `/` before it — optional, so
 * `/dashboard/:path*` matches `/dashboard` as well as `/dashboard/a/b` (Next.js
 * semantics); `:path+` needs at least one segment.
 */
function paramRegExp(re: string, modifier: string | undefined, seg: string): string {
  const afterSlash = re.endsWith("/");
  const base = afterSlash ? re.slice(0, -1) : re;
  const sep = afterSlash ? "/" : "";
  switch (modifier) {
    case "*":
      return `${base}(?:${sep}${seg}(?:/${seg})*)?`;
    case "+":
      return `${base}${sep}${seg}(?:/${seg})*`;
    case "?":
      return `${base}(?:${sep}${seg})?`;
    default:
      return `${re}${seg}`;
  }
}

/** Does `pathname` match any of the configured matchers (or all if none)? */
export function matches(config: MiddlewareConfig | undefined, pathname: string): boolean {
  const matcher = config?.matcher;
  if (!matcher) return true;
  const entries = Array.isArray(matcher) ? matcher : [matcher];
  return entries.some((e) => {
    const source = typeof e === "string" ? e : e?.source;
    return typeof source === "string" && compiledMatcher(source).test(pathname);
  });
}

/** `matcherToRegExp` memoized per source (a matcher is compiled once, not per request). */
const matcherCache = new Map<string, RegExp>();
function compiledMatcher(source: string): RegExp {
  let re = matcherCache.get(source);
  if (!re) {
    re = matcherToRegExp(source);
    if (matcherCache.size >= 256) matcherCache.clear(); // matchers are config, not input
    matcherCache.set(source, re);
  }
  return re;
}

/** Normalize a module export into an ordered list of entries. */
function toEntries(exp: MiddlewareExport): MiddlewareEntry[] {
  const list = Array.isArray(exp) ? exp : [exp];
  return list
    .map((e) => (typeof e === "function" ? { handler: e } : e))
    .filter((e): e is MiddlewareEntry => typeof e?.handler === "function");
}

/** Run one entry against the current request/url and classify its result. */
async function runEntry(
  entry: MiddlewareEntry,
  request: Request,
  url: URL,
  matchPath: string,
): Promise<MiddlewareOutcome> {
  if (!matches(entry.config, matchPath)) return { type: "next" };
  const result = await entry.handler(requestAdapter(request), {
    url,
    waitUntil: (promise) => after(() => promise),
  });

  if (result instanceof Response) {
    // A `NextResponse.next()`/`.rewrite()` is a real Response carrying an intent
    // header — honor it as continue/rewrite rather than short-circuiting.
    const rewriteTarget = result.headers.get(MIDDLEWARE_REWRITE_HEADER);
    if (rewriteTarget) {
      return {
        type: "rewrite",
        url: new URL(rewriteTarget, url).href,
        headers: passthroughHeaders(result.headers),
        requestHeaders: decodeRequestHeaders(result.headers),
      };
    }
    if (result.headers.get(MIDDLEWARE_NEXT_HEADER) !== null) {
      return {
        type: "next",
        headers: passthroughHeaders(result.headers),
        requestHeaders: decodeRequestHeaders(result.headers),
      };
    }
    return { type: "response", response: result };
  }
  if (isRewrite(result)) {
    return {
      type: "rewrite",
      url: new URL(result.destination, url).href,
      headers: result.headers ? new Headers(result.headers) : undefined,
    };
  }
  if (isNext(result)) {
    return {
      type: "next",
      headers: result.headers ? new Headers(result.headers) : undefined,
    };
  }
  return { type: "next" };
}

/** Merge one entry's response headers in, preserving multiple Set-Cookie entries (a plain set() would collapse them). */
function mergeResponseHeaders(into: Headers, from: Headers): void {
  for (const cookie of from.getSetCookie()) into.append("set-cookie", cookie);
  for (const [k, v] of from) {
    if (k !== "set-cookie") into.set(k, v);
  }
}

/**
 * Compose an ordered list of entries into a single {@linkcode MiddlewareRunner}.
 *
 * Entries run in array order. A `Response` short-circuits the chain; a
 * `rewrite` threads its URL into every subsequent entry (so later matchers see
 * the rewritten path); `next({ headers })` accumulates headers cumulatively
 * across the chain. If any entry rewrote, the final outcome is a `rewrite`;
 * otherwise it is `next` with the accumulated headers.
 *
 * @param entries The ordered entries to run.
 * @param moduleConfig Optional matcher gating the whole chain.
 * @returns A runner, or `null` if there are no entries.
 */
export function composeMiddleware(
  entries: MiddlewareEntry[],
  moduleConfig?: MiddlewareConfig,
): MiddlewareRunner {
  if (entries.length === 0) return null;

  return async function run(request: Request, matchPath?: string): Promise<MiddlewareOutcome> {
    let currentRequest = request;
    let url = new URL(request.url);
    const origin = url.origin;
    let path = matchPath ?? url.pathname;

    // A module-level matcher gates the entire chain.
    if (!matches(moduleConfig, path)) return { type: "next", request };

    const accumulated = new Headers();
    let hasHeaders = false;
    let rewritten = false;
    let requestHeaders: Headers | undefined;

    for (const entry of entries) {
      const step = await runEntry(entry, currentRequest, url, path);
      if (step.type === "response") return step; // short-circuit
      if (step.headers) {
        mergeResponseHeaders(accumulated, step.headers);
        hasHeaders = true;
      }
      if (step.requestHeaders) {
        // Apply this entry's request-header overrides so later entries (and the
        // final routed request) see them. The body is consumed exactly once here —
        // callers must route `outcome.request`, never re-wrap the original.
        requestHeaders = step.requestHeaders;
        currentRequest = new Request(currentRequest, { headers: requestHeaders });
      }
      if (step.type === "rewrite") {
        rewritten = true;
        currentRequest = new Request(step.url, currentRequest);
        url = new URL(step.url);
        path = url.pathname;
      }
    }

    const headers = hasHeaders ? accumulated : undefined;
    const outcomeRequest = currentRequest;
    if (rewritten) {
      const external = url.origin !== origin;
      return {
        type: "rewrite",
        url: url.href,
        headers,
        requestHeaders,
        request: outcomeRequest,
        external,
      };
    }
    return { type: "next", headers, requestHeaders, request: outcomeRequest };
  };
}

/**
 * Build a runner from a loaded middleware module. The module may export a single
 * handler or an ordered array of handlers/entries (composed into one chain).
 * Returns null if the module exports no handler.
 */
export function createMiddlewareRunner(mod: MiddlewareModule): MiddlewareRunner {
  const exp = mod.middleware ?? mod.default;
  if (exp === undefined) return null;
  return composeMiddleware(toEntries(exp), mod.config);
}

/** Merge extra headers into a response (returning a new Response if needed). */
export function withHeaders(response: Response, extra?: Headers): Response {
  if (!extra) return response;
  const headers = new Headers(response.headers);
  // Preserve multiple Set-Cookie entries — a plain set() would collapse them to
  // the last one (and wipe the response's own cookies).
  for (const cookie of extra.getSetCookie()) headers.append("set-cookie", cookie);
  for (const [k, v] of extra) {
    if (k === "set-cookie") continue;
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
