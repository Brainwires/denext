// Root middleware support (Next.js-style `middleware.ts`, with `proxy.ts` as an
// accepted alias). The middleware runs before routing and may short-circuit
// with a Response, redirect, rewrite the URL used for routing, or continue
// (optionally injecting response headers).

const NEXT = Symbol.for("denext.middleware.next");
const REWRITE = Symbol.for("denext.middleware.rewrite");

export interface MiddlewareContext {
  /** The request URL, pre-parsed for convenience. */
  url: URL;
}

export interface NextCommand {
  [NEXT]: true;
  headers?: HeadersInit;
}

export interface RewriteCommand {
  [REWRITE]: true;
  destination: string;
  headers?: HeadersInit;
}

export type MiddlewareResult =
  | Response
  | NextCommand
  | RewriteCommand
  | void
  | undefined;

export type Middleware = (
  request: Request,
  context: MiddlewareContext,
) => MiddlewareResult | Promise<MiddlewareResult>;

export interface MiddlewareConfig {
  /** Path pattern(s) the middleware applies to. Omit to run on every request. */
  matcher?: string | string[];
}

export interface MiddlewareModule {
  default?: Middleware;
  middleware?: Middleware;
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
