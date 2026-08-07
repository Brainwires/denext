// Root middleware support (Next.js-style `middleware.ts`, with `proxy.ts` as an
// accepted alias). The middleware runs before routing and may short-circuit
// with a Response, redirect, rewrite the URL used for routing, or continue
// (optionally injecting response headers).

/** Internal marker symbol keying a {@linkcode NextCommand}. */
export const NEXT: unique symbol = Symbol.for("denext.middleware.next");
/** Internal marker symbol keying a {@linkcode RewriteCommand}. */
export const REWRITE: unique symbol = Symbol.for("denext.middleware.rewrite");

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

/** Shape of a `middleware.ts`/`proxy.ts` module. */
export interface MiddlewareModule {
  /** The middleware handler when exported as the default. */
  default?: Middleware;
  /** The middleware handler when exported as `middleware`. */
  middleware?: Middleware;
  /** Optional matcher configuration. */
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

/** Return a client redirect response. */
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

/**
 * Build a runner from a loaded middleware module. Returns null if the module
 * exports no handler.
 */
export function createMiddlewareRunner(mod: MiddlewareModule): MiddlewareRunner {
  const handler = mod.middleware ?? mod.default;
  if (typeof handler !== "function") return null;

  return async function run(request: Request): Promise<MiddlewareOutcome> {
    const url = new URL(request.url);
    if (!matches(mod.config, url.pathname)) {
      return { type: "next" };
    }
    const result = await handler(request, { url });

    if (result instanceof Response) {
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
  };
}

/** Merge extra headers into a response (returning a new Response if needed). */
export function withHeaders(response: Response, extra?: Headers): Response {
  if (!extra) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of extra) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
