// The state the request pipeline threads through its stages: the per-app values
// createApp derives once (`AppRuntime`) and the mutable per-request routing state
// (`RequestState`), plus `finalize`, which every response leaves through.

import { copyRemoteAddr, type LimitAddrPolicy } from "./remote-addr.ts";
import type { AppConfig, RequestHandler } from "./app-config.ts";
import type { RequestContext } from "./request-context.ts";
import type { CorsPolicy } from "./cors.ts";
import type { RequestErrorContext } from "./instrumentation.ts";
import {
  type CompiledPattern,
  compilePattern,
  type HeaderRule,
  type RedirectRule,
  type RewriteRule,
} from "./config.ts";
import { mergeHeaders, withHeaders } from "./middleware.ts";
import { applyOutgoing } from "./response-headers.ts";

/** The config-driven URL rules (denext.config redirects/rewrites/headers), compiled. */
export interface CompiledRules {
  redirects: Array<{ pattern: CompiledPattern; rule: RedirectRule }>;
  rewrites: Array<{ pattern: CompiledPattern; rule: RewriteRule }>;
  headers: Array<{ pattern: CompiledPattern; rule: HeaderRule }>;
}

/** Compile the config's redirect / rewrite / header rules into matchable patterns. */
export function compileRules(config: AppConfig): CompiledRules {
  const compile = <R extends { source: string }>(rules: R[] | undefined) =>
    (rules ?? []).map((rule) => ({ pattern: compilePattern(rule.source), rule }));
  return {
    redirects: compile(config.redirects),
    rewrites: compile(config.rewrites),
    headers: compile(config.headerRules),
  };
}

/** What createApp derives once from its config and every request stage reads. */
export interface AppRuntime {
  config: AppConfig;
  /** `config.basePath` without its trailing slash (`""` when unset). */
  basePath: string;
  /**
   * The compiled config rules, built lazily on first use — the dev server resolves
   * rules asynchronously after createApp is called.
   */
  rules(): CompiledRules;
  /** The app's own handler; the ISR background regeneration loops back through it. */
  handle: RequestHandler;
  /** The app-level CORS policy (`config.cors`, resolved at `createApp`), or `null` for none. */
  cors?: CorsPolicy | null;
  /** The `appLinks` association-file handler (`null` for a request it does not answer). */
  appLinks?: (request: Request) => Response | null;
  /** The per-address limit policy (`rateLimitHeader` / `rateLimitLocalAddresses`), resolved once. */
  limitPolicy?: LimitAddrPolicy;
}

/** The mutable routing state of one request as it moves through the pipeline. */
export interface RequestState {
  app: AppRuntime;
  ctx: RequestContext;
  /** The request as currently routed (rebuilt by basePath, rewrites and middleware). */
  request: Request;
  url: URL;
  pathname: string;
  /** Headers from config header rules and middleware, applied by {@link finalize}. */
  injectedHeaders?: Headers;
  /**
   * Whether a `middleware.ts` matched this request (a handler ran, or a runner that does not say).
   * `cdnCacheHeaders` holds its public header back then, unless `evenWithMiddleware`.
   */
  middlewareMatched?: boolean;
  /**
   * Set when this request is the ISR "leader" for a cache key — released in the
   * pipeline's finally so concurrent requests for the same key stop waiting.
   */
  releasePageLeader?: () => void;
  /**
   * What the request was dispatched to, so the top-level catch can label the error's
   * `routeType` for onRequestError (API errors bubble there).
   */
  dispatchRouteType: RequestErrorContext["routeType"];
}

/** Route the rest of the pipeline as if the request were for `url`. */
export function retarget(state: RequestState, url: URL): void {
  state.url = url;
  state.pathname = url.pathname;
  const rebuilt = new Request(url.toString(), state.request);
  copyRemoteAddr(state.request, rebuilt); // keep the socket peer (clientIp, per-address limits)
  state.request = rebuilt;
}

/** Queue a header for the response (config header rules, middleware headers). */
export function addInjectedHeader(state: RequestState, key: string, value: string): void {
  const headers = state.injectedHeaders ??= new Headers();
  // A single-valued header (X-Frame-Options, CSP, HSTS, …) from a later source (middleware)
  // REPLACES an earlier one (config header rules) — `DENY, SAMEORIGIN` is not a valid value.
  if (SINGLETON_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  else headers.append(key, value);
}

/** Response headers that hold exactly one value (the last writer wins, as in Next.js). */
const SINGLETON_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "referrer-policy",
  "x-content-type-options",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "content-type",
  "cache-control",
  "location",
]);

/** The injected (rule + middleware) headers applied to `res`, if there are any. */
function withInjectedHeaders(state: RequestState, res: Response): Response {
  return state.injectedHeaders ? withHeaders(res, state.injectedHeaders) : res;
}

/**
 * Every routed response leaves through here: the injected headers, then the
 * request-queued outgoing headers (cookies().set() Set-Cookie, and any loader/action-set
 * headers e.g. Remix `data(value, { headers })`) plus an optional loader/action-requested
 * status override (`data(value, { status })`).
 */
export function finalize(state: RequestState, res: Response): Response {
  return applyOutgoing(
    withInjectedHeaders(state, res),
    state.ctx.outgoingHeaders,
    state.ctx.responseStatus,
  );
}

/**
 * {@linkcode finalize} for a response built from one that already left through it (a page request
 * middleware's own response after `render()`, or a copy of the rendered one): the injected and
 * request-queued headers it lacks are added, a Set-Cookie it already carries is not repeated, and
 * its status is kept (a loader's status override belongs to the rendered response, not to a
 * redirect the middleware answers with).
 *
 * @param state The request state.
 * @param res The response the middleware resolved to.
 * @returns `res`, or a copy with the missing headers.
 */
export function finalizeLacking(state: RequestState, res: Response): Response {
  const headers = new Headers(res.headers);
  const cookies = new Set(headers.getSetCookie());
  // Outgoing after injected, as in `finalize`: a header both set takes the outgoing value.
  const added = addLacking(res.headers, headers, cookies, state.injectedHeaders) +
    addLacking(res.headers, headers, cookies, state.ctx.outgoingHeaders);
  if (added === 0) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Add to `headers` what `from` has and `own` lacks (a Set-Cookie not in `cookies`); the count. */
function addLacking(
  own: Headers,
  headers: Headers,
  cookies: Set<string>,
  from: Headers | undefined,
): number {
  let added = 0;
  for (const cookie of from?.getSetCookie() ?? []) {
    if (cookies.has(cookie)) continue;
    cookies.add(cookie);
    headers.append("set-cookie", cookie);
    added++;
  }
  for (const [key, value] of from ?? []) {
    if (key === "set-cookie" || own.has(key)) continue;
    headers.set(key, value);
    added++;
  }
  return added;
}

/**
 * {@linkcode finalize} of `new Response(body, { status, headers })`, with the injected headers
 * merged into `headers` before the response is made rather than into a copy of it afterwards:
 * the same response, constructed once. (A copy costs a second `Headers` and `Response`, and the
 * runtime prepares each response's native header block as it is constructed.)
 *
 * @param state The request state.
 * @param body The response body.
 * @param status The response status.
 * @param headers The response's own headers.
 * @returns The finalized response.
 */
export function finalizeNew(
  state: RequestState,
  body: BodyInit | null,
  status: number,
  headers: HeadersInit,
): Response {
  const own = state.injectedHeaders
    ? mergeHeaders(new Headers(headers), state.injectedHeaders)
    : headers;
  return applyOutgoing(
    new Response(body, { status, headers: own }),
    state.ctx.outgoingHeaders,
    state.ctx.responseStatus,
  );
}
