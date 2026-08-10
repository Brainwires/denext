// Root middleware support (Next.js-style `middleware.ts`, with `proxy.ts` as an
// accepted alias). The middleware runs before routing and may short-circuit
// with a Response, redirect, rewrite the URL used for routing, or continue
// (optionally injecting response headers).

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

/** Extra context passed to a middleware handler alongside the request. */
export interface MiddlewareContext {
  /** The request URL, pre-parsed for convenience. */
  url: URL;
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

/** Optional configuration exported by a middleware module. */
export interface MiddlewareConfig {
  /** Path pattern(s) the middleware applies to. Omit to run on every request. */
  matcher?: string | string[];
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
 * SECURITY: `location` is emitted **verbatim** — this helper does not sanitize it.
 * Passing a user-controlled value (e.g. a `?next=` param) is an open redirect. For
 * an untrusted destination, allowlist it or normalize it with
 * {@linkcode safeRedirectLocation} (which forces a same-origin path). Config-driven
 * `redirects()` are already normalized; this manual helper is not.
 *
 * @param location The redirect target (trusted, or pre-validated by the caller).
 * @param status The redirect status code (default 307).
 */
export function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location } });
}

// ---- Runner ----------------------------------------------------------------

/** The normalized result of running the middleware runner for a request. */
export type MiddlewareOutcome =
  | { type: "response"; response: Response }
  | { type: "rewrite"; url: string; headers?: Headers }
  | { type: "next"; headers?: Headers };

/** A resolved, request-ready middleware runner (null when there is none). */
export type MiddlewareRunner =
  | ((request: Request) => Promise<MiddlewareOutcome>)
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
    if (k === MIDDLEWARE_NEXT_HEADER || k === MIDDLEWARE_REWRITE_HEADER || k === "set-cookie") {
      continue;
    }
    out.set(k, v);
    any = true;
  }
  return any ? out : undefined;
}

function isNext(v: unknown): v is NextCommand {
  return typeof v === "object" && v !== null && NEXT in v;
}
function isRewrite(v: unknown): v is RewriteCommand {
  return typeof v === "object" && v !== null && REWRITE in v;
}

/** Compile a matcher pattern into a RegExp. Supports `:name`, `:name*`, `*`. */
export function matcherToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === ":") {
      i++;
      let name = "";
      while (i < pattern.length && /[A-Za-z0-9_]/.test(pattern[i])) {
        name += pattern[i++];
      }
      if (pattern[i] === "*") {
        i++;
        re += ".*";
      } else {
        re += "[^/]+";
      }
      void name;
    } else if (ch === "*") {
      i++;
      re += ".*";
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does `pathname` match any of the configured matchers (or all if none)? */
export function matches(config: MiddlewareConfig | undefined, pathname: string): boolean {
  const matcher = config?.matcher;
  if (!matcher) return true;
  const patterns = Array.isArray(matcher) ? matcher : [matcher];
  return patterns.some((p) => matcherToRegExp(p).test(pathname));
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
): Promise<MiddlewareOutcome> {
  if (!matches(entry.config, url.pathname)) return { type: "next" };
  const result = await entry.handler(requestAdapter(request), { url });

  if (result instanceof Response) {
    // A `NextResponse.next()`/`.rewrite()` is a real Response carrying an intent
    // header — honor it as continue/rewrite rather than short-circuiting.
    const rewriteTarget = result.headers.get(MIDDLEWARE_REWRITE_HEADER);
    if (rewriteTarget) {
      return {
        type: "rewrite",
        url: new URL(rewriteTarget, url).href,
        headers: passthroughHeaders(result.headers),
      };
    }
    if (result.headers.get(MIDDLEWARE_NEXT_HEADER) !== null) {
      return { type: "next", headers: passthroughHeaders(result.headers) };
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

  return async function run(request: Request): Promise<MiddlewareOutcome> {
    let currentRequest = request;
    let url = new URL(request.url);

    // A module-level matcher gates the entire chain.
    if (!matches(moduleConfig, url.pathname)) return { type: "next" };

    const accumulated = new Headers();
    let hasHeaders = false;
    let rewritten = false;

    for (const entry of entries) {
      const step = await runEntry(entry, currentRequest, url);
      if (step.type === "response") return step; // short-circuit
      if (step.headers) {
        // Preserve multiple Set-Cookie entries (a plain set() would collapse them).
        for (const cookie of step.headers.getSetCookie()) accumulated.append("set-cookie", cookie);
        for (const [k, v] of step.headers) {
          if (k === "set-cookie") continue;
          accumulated.set(k, v);
        }
        hasHeaders = true;
      }
      if (step.type === "rewrite") {
        rewritten = true;
        currentRequest = new Request(step.url, currentRequest);
        url = new URL(step.url);
      }
    }

    const headers = hasHeaders ? accumulated : undefined;
    if (rewritten) return { type: "rewrite", url: url.href, headers };
    return { type: "next", headers };
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
