// The request pipeline: the ordered routing stages one request runs through — path
// canonicalization, config URL rules, middleware, Server Actions, metadata files, i18n,
// API routes, pages, and the 405 / plugin / static / 404 fallbacks — plus the top-level
// error handling. `createApp` wraps this with the per-request context, timeout,
// hardening headers and logging.

import { copyRemoteAddr } from "./remote-addr.ts";
// Recognize a library's own Next.js-format errors (redirect / notFound / …) as denext's signals.
import "./next-signals.ts";
import { isThenable, setSuspenseOriginTrace } from "../runtime/suspense.ts";
import type { RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderRootNotFound } from "./render-page.ts";
import { type RequestContext, runDeferred } from "./request-context.ts";
import { renderDocument } from "./document.ts";
import { resolveCsp } from "./csp.ts";
import { serveStatic } from "./static.ts";
import {
  middlewareMatched,
  type MiddlewareOutcome,
  redirectResponse,
  withHeaders,
} from "./middleware.ts";
import { safeFetch } from "./safe-fetch.ts";
import { localeDomainHost, type PeeledLocale, peelLocale } from "./i18n.ts";
import { fillDestination, matchPattern, safeRedirectLocation } from "./config.ts";
import { handleAction, isActionRequest } from "./action-handler.ts";
import { handleApiBatch, isApiBatchRequest } from "./api-batch-handler.ts";
import { API_BATCH_PATH, BATCH_ITEM_HEADER } from "../runtime/api-batch-protocol.ts";
import { ACTION_PREFIX } from "../runtime/server-action.ts";
import { runSubRequest } from "./sub-request.ts";
import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "./body.ts";
import { serveMetadataFile } from "./metadata-files.ts";
import { requestOrigin } from "./absolute-url.ts";
import { documentPublicEnv } from "../runtime/public-env.ts";
import { isAbortError } from "./abort.ts";
import { isReadMethod, originOptions, reportRequestError } from "./app-config.ts";
import {
  addInjectedHeader,
  type AppRuntime,
  finalize,
  type RequestState,
  retarget,
} from "./pipeline-state.ts";
import { documentBody, htmlHeaders, notFound } from "./response-headers.ts";
import { servePage } from "./page-response.ts";
import { applyCors, endpointCorsPolicy, isPreflight, preflightResponse } from "./cors.ts";

// `DENEXT_DEBUG_SUSPENSE=1`: `use()` remembers where each suspension started (`_origin`), so a
// thenable that escapes every boundary can be traced below (a raw Promise carries no stack of
// its own). The env is read once, on the first suspension.
let debugSuspenseFlag: boolean | null = null;
setSuspenseOriginTrace((thenable) => {
  if (debugSuspenseFlag === null) {
    try {
      debugSuspenseFlag = !!Deno.env.get("DENEXT_DEBUG_SUSPENSE");
    } catch {
      debugSuspenseFlag = false;
    }
  }
  if (debugSuspenseFlag) thenable._origin = new Error("use() suspended here").stack;
});

/**
 * Path canonicalization (before config rules, middleware, and routing): collapse runs
 * of `/` so the middleware matcher, config redirects/rewrites, and the router all
 * evaluate the SAME path. The router drops empty segments (`//admin` resolves to the
 * `/admin` page), but a matcher/rule anchored on `/admin` and tested against the raw
 * pathname does NOT — so `//admin` would render the page while SKIPPING a middleware
 * auth guard on `/admin` (an auth bypass). A 308 (method + body preserved) to the
 * collapsed form closes that mismatch and lets caches/SEO converge on the canonical URL.
 * Then trailing-slash normalization → 308 to the canonical form (framework asset paths
 * and requests for files with an extension are exempt). Unset `trailingSlash` means
 * Next's default (no slash): `/dashboard/` redirects to `/dashboard`, so a middleware
 * matcher and the router never disagree about which spelling is the page.
 */
function canonicalizePath(state: RequestState): Response | null {
  const { pathname, url } = state;
  const { config } = state.app;
  if (pathname.includes("//")) {
    const canonical = pathname.replace(/\/{2,}/g, "/");
    if (canonical !== pathname) {
      return redirectResponse(safeRedirectLocation(canonical) + url.search, 308);
    }
  }
  const isFrameworkPath = pathname.startsWith("/_denext");
  const isFile = /\.[^/]+$/.test(pathname);
  if (isFrameworkPath || isFile || pathname === "/") return null;
  const hasSlash = pathname.endsWith("/");
  const wantSlash = config.trailingSlash === true; // unset = Next's default: no slash
  if (wantSlash && !hasSlash) {
    return redirectResponse(safeRedirectLocation(pathname + "/") + url.search, 308);
  }
  if (!wantSlash && hasSlash) {
    return redirectResponse(safeRedirectLocation(pathname.replace(/\/+$/, "")) + url.search, 308);
  }
  return null;
}

/** Config redirects (denext.config): first match wins (permanent → 308, else 307). */
function applyRedirectRules(state: RequestState): Response | null {
  for (const { pattern, rule } of state.app.rules().redirects) {
    const params = matchPattern(pattern, state.pathname);
    if (params) {
      return redirectResponse(
        safeRedirectLocation(fillDestination(rule.destination, params)),
        rule.permanent ? 308 : 307,
      );
    }
  }
  return null;
}

/** basePath: strip the configured prefix so routing sees the app-relative path. */
function stripBasePath(state: RequestState): void {
  const { basePath } = state.app;
  const { pathname } = state;
  if (!basePath || pathname.startsWith("/_denext")) return;
  if (pathname !== basePath && !pathname.startsWith(basePath + "/")) return;
  const stripped = pathname.slice(basePath.length) || "/";
  const url = new URL(state.request.url);
  url.pathname = stripped;
  state.url = url;
  state.pathname = stripped;
  const rebuilt = new Request(url.toString(), state.request);
  copyRemoteAddr(state.request, rebuilt); // keep the socket peer (clientIp, per-address limits)
  state.request = rebuilt;
}

/**
 * The remaining config URL rules: header rules accumulate onto matching responses (via
 * the injected headers); the first matching rewrite internally routes as its
 * destination (no client redirect).
 */
/** basePath strip + config `headers` rules — before middleware (Next's order). */
function applyHeaderRules(state: RequestState): void {
  stripBasePath(state);
  for (const { pattern, rule } of state.app.rules().headers) {
    if (!matchPattern(pattern, state.pathname)) continue;
    for (const { key, value } of rule.headers) addInjectedHeader(state, key, value);
  }
}

/** Config `rewrites` — after middleware, so matchers saw the URL the client asked for. */
function applyRewriteRules(state: RequestState): void {
  for (const { pattern, rule } of state.app.rules().rewrites) {
    const params = matchPattern(pattern, state.pathname);
    if (params) {
      retarget(state, new URL(fillDestination(rule.destination, params), state.url.origin));
      break;
    }
  }
}

/**
 * Root middleware runs before routing. A response ends the request (with the header
 * rules applied); a rewrite routes as if the request were for the rewritten URL;
 * request-header overrides from `NextResponse.next({ request })` reach the downstream
 * handler; middleware headers merge on top of the config header rules. An error thrown
 * inside middleware is labeled "proxy" (Next's routeType for middleware/proxy).
 */
async function runMiddleware(state: RequestState): Promise<Response | null> {
  const { config } = state.app;
  const runner = config.getMiddleware ? await config.getMiddleware() : null;
  if (!runner) return null;
  state.dispatchRouteType = "proxy";
  // Matchers see the locale-stripped path (Next strips the i18n prefix before middleware).
  const outcome = await runner(state.request, resolveLocale(state)?.rest);
  state.dispatchRouteType = "render";
  state.middlewareMatched = middlewareMatched(outcome);
  // A short-circuit Response still leaves through finalize(): cookies().set() queued in
  // the middleware and the injected header rules must reach the client.
  if (outcome.type === "response") return finalize(state, outcome.response);
  // The runner already applied request-header overrides / the rewrite URL to
  // `outcome.request` (consuming the original body once) — route THAT request. A custom
  // runner that returns no `request` gets the same treatment applied here.
  if (outcome.request) {
    copyRemoteAddr(state.request, outcome.request);
    state.request = outcome.request;
    // `headers()` / `NextRequest` adapters read `ctx.request`: keep it on the request as
    // middleware left it (header overrides included).
    routeContextTo(state, state.request);
  } else applyOutcomeToRequest(state, outcome);
  if (outcome.type === "rewrite") {
    if (outcome.external) return proxyExternalRewrite(state, outcome.url, outcome.headers);
    state.url = new URL(state.request.url);
    state.pathname = state.url.pathname;
  }
  if (outcome.headers) {
    for (const [k, v] of outcome.headers) {
      // A middleware Set-Cookie is queued on the request context (so `cookies().get()`
      // later in this request sees it) and reaches the client through finalize().
      if (k === "set-cookie") state.ctx.outgoingHeaders.append(k, v);
      else addInjectedHeader(state, k, v);
    }
  }
  return null;
}

/** Rebuild the routed request from a runner outcome that did not supply one. */
function applyOutcomeToRequest(state: RequestState, outcome: MiddlewareOutcome): void {
  if (outcome.type === "rewrite") {
    const rewritten = new Request(outcome.url, state.request);
    copyRemoteAddr(state.request, rewritten);
    state.request = rewritten;
  }
  if (outcome.type !== "response" && outcome.requestHeaders) {
    const rebuilt = new Request(state.request, { headers: outcome.requestHeaders });
    copyRemoteAddr(state.request, rebuilt);
    state.request = rebuilt;
    routeContextTo(state, rebuilt);
  }
}

/**
 * Point the request context at the request middleware left: `headers()` reads `ctx.request`,
 * and a view it memoized while middleware ran (a library's middleware calling `headers()`) would
 * otherwise hide the overridden request headers from the route (`@clerk/nextjs`'s `auth()` reads
 * the `x-clerk-auth-*` headers its middleware sets).
 */
function routeContextTo(state: RequestState, request: Request): void {
  state.ctx.request = request;
  state.ctx.readonlyHeaders = undefined;
}

/** Request headers never forwarded to an external rewrite target. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

/**
 * `NextResponse.rewrite("https://other.host/…")`: Next proxies the request to the other
 * origin. denext does the same through the SSRF-guarded `safeFetch` (private/internal
 * addresses are refused, redirects re-validated), forwarding method, body and headers
 * minus the hop-by-hop set. Middleware response headers are merged onto the proxied reply.
 */
async function proxyExternalRewrite(
  state: RequestState,
  target: string,
  extra?: Headers,
): Promise<Response> {
  const { request } = state;
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!HOP_HEADERS.has(k)) headers.set(k, v);
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  let upstream: Response;
  try {
    upstream = await safeFetch(target, { method: request.method, headers, body });
  } catch (err) {
    // Refused (private/internal target, DNS failure, timeout) → a gateway error, never a
    // silent local render of the same path.
    console.error("denext: external rewrite refused", target, err);
    return finalize(state, new Response("Bad Gateway", { status: 502 }));
  }
  const res = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  return finalize(state, extra ? withHeaders(res, extra) : res);
}

/**
 * Server Actions: a POST to the reserved action endpoint, dispatched before routing.
 * Same-origin is enforced inside handleAction (CSRF defense). A thrown Server Action
 * returns a normal 500 here, so it is reported to instrumentation from this stage — it
 * never reaches the top-level catch (M2).
 */
async function dispatchAction(state: RequestState): Promise<Response> {
  const { config } = state.app;
  const { request, pathname } = state;
  const res = await handleAction(request, {
    allowedOrigins: config.allowedOrigins,
    canonicalOrigin: config.canonicalOrigin,
    trustForwardedHeaders: config.trustForwardedHeaders,
    desktopAppOrigin: config.desktopAppOrigin,
    cors: state.app.cors ?? null,
    maxBodyBytes: config.actionMaxBodyBytes,
    scope: config.actionScope,
    onError: (err) => reportRequestError(config, err, request, pathname, { routeType: "action" }),
  });
  return finalize(state, res);
}

/** Metadata files (sitemap.xml / robots.txt / manifest.webmanifest / favicon), GET/HEAD only. */
async function serveMetadata(
  state: RequestState,
  manifest: RouteManifest,
): Promise<Response | null> {
  if (!isReadMethod(state.request)) return null;
  const { config } = state.app;
  const metaFile = await serveMetadataFile(
    manifest,
    state.pathname,
    config.load,
    requestOrigin(state.request, originOptions(config)),
    !config.canonicalOrigin, // Host-derived ⇒ the sitemap index is sent no-store
  );
  return metaFile ? finalize(state, metaFile) : null;
}

/**
 * i18n: peel an optional locale prefix off the path. Matching runs against the stripped
 * path; the locale is merged into route params. With `i18n.domains`, the locale for an
 * unprefixed path depends on the host — the request's trusted host ({@link localeDomainHost}:
 * `X-Forwarded-Host` only under `trustForwardedHeaders`), matched against the configured
 * domains only, and only paid for when domain routing is configured.
 */
function resolveLocale(state: RequestState): PeeledLocale | null {
  const { config } = state.app;
  if (!config.i18n) return null;
  // Not `originOptions(config)`: `canonicalOrigin` must not mask domain routing.
  const localeHost = config.i18n.domains
    ? localeDomainHost(state.request, config.trustForwardedHeaders)
    : undefined;
  return peelLocale(state.pathname, config.i18n, localeHost);
}

/**
 * A soft-navigation POST (carries `x-denext-nav` + a body) is a RENDER with a payload
 * too large for headers — not a Server Action / `route.ts` call. It skips the API match
 * and flows into the page render; its body is stashed for the feature that sent it (the
 * Remix `shouldRevalidate` prior-data echo). Read once, here.
 */
async function stashSoftNavBody(state: RequestState): Promise<boolean | Response> {
  const { request, ctx } = state;
  const softNavPost = request.method === "POST" && request.headers.get("x-denext-nav") === "1";
  if (!softNavPost) return false;
  // Bounded read (size cap + idle timeout) — this runs before routing, for ANY path, so an
  // unbounded `request.clone().json()` here was an unauthenticated memory-exhaustion lever.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_SOFT_NAV_BODY) return textResponse("Payload Too Large", 413);
  const body = await readCappedBody(request, MAX_SOFT_NAV_BODY);
  if (body === TOO_LARGE) return textResponse("Payload Too Large", 413);
  if (body === STALLED) return textResponse("Request Timeout", 408);
  try {
    ctx.softNavBody = body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : undefined;
  } catch {
    ctx.softNavBody = undefined;
  }
  // The body was consumed; downstream sees an equivalent request with the bytes replayed.
  state.request = bufferedRequest(request, body);
  return true;
}

/** Max bytes of a soft-navigation POST echo body (the prior-data payload is small). */
const MAX_SOFT_NAV_BODY = 1024 * 1024;

function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * API routes. A `route.ts` handles the methods it exports; when it matches but exports
 * no handler for THIS method (handleApi → 405) and a page also lives at this path (a
 * GET/HEAD render), fall through to the page — so `page.tsx` and `route.ts` can coexist
 * in one segment (e.g. a migrated Remix route: `route.ts` owns the action POST,
 * `page.tsx` the GET/render). A lone `route.ts` (no page) still 405s. The discarded 405
 * ran no handler, so there is no body/stream to leak.
 */
async function dispatchApi(
  state: RequestState,
  manifest: RouteManifest,
  routingPath: string,
  softNavPost: boolean,
): Promise<Response | null> {
  const api = matchApi(manifest, routingPath);
  if (!api || softNavPost) return null;
  state.dispatchRouteType = "route"; // so a THROWING API handler is labeled "route"
  const { config } = state.app;
  const apiRes = await handleApi(api, state.request, config.load, {
    maxBodyBytes: config.apiMaxBodyBytes,
    cors: state.app.cors,
    onError: (err) =>
      reportRequestError(config, err, state.request, state.pathname, { routeType: "route" }),
  });
  const fallThroughToPage = apiRes.status === 405 && rendersPage(state) &&
    matchPage(manifest, routingPath, { soft: false }) !== null;
  if (!fallThroughToPage) return finalize(state, apiRes);
  state.dispatchRouteType = "render"; // handed off to the page render
  return null;
}

/**
 * Whether this request's method renders a page: GET / HEAD, or any method a compat middleware
 * handled and handed to the page ({@link RequestContext.renderPageForMethod}).
 */
function rendersPage(state: RequestState): boolean {
  return isReadMethod(state.request) || state.ctx.renderPageForMethod === true;
}

/**
 * Pages: GET/HEAD, plus a soft-nav POST carrying an over-large render payload, and a request a
 * compat middleware handed to the page.
 */
function dispatchPage(
  state: RequestState,
  manifest: RouteManifest,
  routingPath: string,
  localeInfo: PeeledLocale | null,
  softNavPost: boolean,
): Promise<Response> | null {
  if (!rendersPage(state) && !softNavPost) return null;
  // Soft (client) navigations carry x-denext-nav; enables interception.
  const soft = state.request.headers.get("x-denext-nav") === "1";
  const matched = matchPage(manifest, routingPath, { soft });
  if (!matched) return null;
  return servePage(state, { manifest, matched, localeInfo, soft, routingPath });
}

/** The app's root not-found UI, as a full document (HEAD gets the headers only). */
async function serveNotFoundPage(state: RequestState, manifest: RouteManifest): Promise<Response> {
  const { config } = state.app;
  const { html, metadata, status } = await renderRootNotFound(manifest, config.load);
  const doc = renderDocument({
    bodyHtml: html,
    metadata,
    devScript: config.devScript,
    devScriptSrc: config.devScriptSrc,
    lang: config.i18n?.defaultLocale,
    publicEnv: documentPublicEnv(config.publicEnvKeys),
  });
  const csp = await resolveCsp(doc, undefined, config.csp);
  const { body, headers } = documentBody(state.request, doc);
  return finalize(state, new Response(body, { status, headers: htmlHeaders(csp, headers) }));
}

/**
 * Nothing matched. A real page URL reached by a method other than GET/HEAD is a 405, not
 * a 404 — the resource exists, the method doesn't (Server Actions and API routes were
 * already handled). Then the plugin claim-hook (e.g. a Pages Router) — after App-Router
 * matching so core routes always win, before static assets + 404; the plugin owns method
 * handling for the routes it claims. Then static assets, then the root not-found UI for
 * page requests, and a bare 404 for everything else.
 */
async function serveFallback(
  state: RequestState,
  manifest: RouteManifest,
  routingPath: string,
): Promise<Response> {
  const { config } = state.app;
  const { request, pathname } = state;
  if (!isReadMethod(request) && matchPage(manifest, routingPath, { soft: false })) {
    const res = new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
    return finalize(state, res);
  }
  if (config.matchExternal) {
    const claimed = await config.matchExternal(request);
    if (claimed) return finalize(state, claimed);
  }
  if (!isReadMethod(request)) return finalize(state, notFound(pathname));
  const asset = await serveStaticDirs(request, pathname, [config.emittedDir, config.publicDir]);
  if (asset) return finalize(state, asset);
  return serveNotFoundPage(state, manifest);
}

/**
 * The first of `dirs` holding `pathname` as a static file: the files plugin build steps
 * published (`emitFile`) at build, then `public/` — so an emitted file replaces a same-named
 * public one, as it does in an export. Unset dirs are skipped.
 */
async function serveStaticDirs(
  request: Request,
  pathname: string,
  dirs: readonly (string | undefined)[],
): Promise<Response | null> {
  const encoding = request.headers.get("accept-encoding") ?? undefined;
  for (const dir of dirs) {
    const asset = dir ? await serveStatic(dir, pathname, encoding, request) : null;
    if (asset) return asset;
  }
  return null;
}

/** The reserved `/_denext/*` RPC endpoints dispatched before routing: actions and the batch. */
function dispatchReserved(state: RequestState): Promise<Response> | null {
  if (isActionRequest(state.request, state.pathname)) {
    return withAppCors(state, dispatchAction(state));
  }
  if (isApiBatchRequest(state.request, state.pathname)) {
    return withAppCors(
      state,
      handleApiBatch(state, (req, ctx) => runSubRequest(runPipeline, state.app, req, ctx)),
    );
  }
  return null;
}

/**
 * The app's `cors` headers on a response that isn't an API route's (those run their own
 * endpoint policy): a page, a Server Action, the batch, a static file or the not-found page.
 */
async function withAppCors(state: RequestState, pending: Promise<Response>): Promise<Response> {
  return applyCors(state.request, await pending, state.app.cors ?? null);
}

/**
 * A sub-request no App Router API route matched: a plugin's request handler (a Pages Router
 * API route, a plugin-served endpoint) gets it — the same claim-hook a real request reaches —
 * else a bare JSON 404 (never a page render or an asset of the App Router's own).
 */
async function dispatchSubRequestFallback(state: RequestState): Promise<Response> {
  const claimed = await state.app.config.matchExternal?.(state.request);
  return finalize(state, claimed ?? subRequestNotFound(state.pathname));
}

/** A sub-request that matched no API route: a bare JSON 404 (never a page or an asset). */
function subRequestNotFound(pathname: string): Response {
  return new Response(
    JSON.stringify({ error: { code: "not_found", status: 404, message: pathname } }),
    {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * A CORS preflight is answered here — before middleware. For an API route, under the route's
 * effective policy (the `cors()` middleware on the asked-about method's handler, else its
 * `export const cors`, else the app's `cors`); for anything else (a page, a Server Action, the
 * API batch), under the app's `cors`. A preflight carries no credentials, so an auth guard in
 * `middleware.ts` would otherwise refuse it and the browser would never send the real request.
 * Nothing covers the path → `null`, and the request continues as before (a route's own
 * `OPTIONS` export, or a 405).
 */
async function answerApiPreflight(state: RequestState): Promise<Response | null> {
  if (!isPreflight(state.request)) return null;
  if (state.request.headers.get(BATCH_ITEM_HEADER) === "1") return null;
  const manifest = await state.app.config.getManifest();
  const locale = resolveLocale(state);
  const routingPath = locale ? locale.rest : state.pathname;
  const api = matchApi(manifest, routingPath);
  const policy = api
    ? endpointCorsPolicy(
      state.app.cors ?? null,
      await state.app.config.load(api.route.filePath),
      state.request,
    )
    : appCorsCovers(state, manifest, routingPath)
    ? state.app.cors ?? null
    : null;
  return policy ? finalize(state, preflightResponse(state.request, policy)) : null;
}

/** Whether the app's `cors` covers a non-API path: a Server Action, the API batch, or a page. */
function appCorsCovers(state: RequestState, manifest: RouteManifest, routingPath: string): boolean {
  const { pathname } = state;
  return pathname.startsWith(ACTION_PREFIX) || pathname === API_BATCH_PATH ||
    !!matchPage(manifest, routingPath, { soft: false });
}

/** The routing stages, in order; each either produces the response or hands on. */
async function dispatch(state: RequestState): Promise<Response> {
  // Universal link / App Link association files: iOS and Android refuse a redirected answer,
  // so they are served before basePath, trailingSlash, redirects and middleware.
  const association = state.app.appLinks?.(state.request);
  if (association) return association;
  const redirected = canonicalizePath(state) ?? applyRedirectRules(state);
  if (redirected) return redirected;
  // Next's order: headers → redirects → MIDDLEWARE → rewrites → filesystem. Middleware
  // matchers must see the URL the client asked for, not a config rewrite's destination.
  applyHeaderRules(state);
  const preflight = await answerApiPreflight(state);
  if (preflight) return preflight;
  const fromMiddleware = await runMiddleware(state);
  if (fromMiddleware) return fromMiddleware;
  applyRewriteRules(state);
  // A sub-request (a batch item, an SSR self-call) is API-only: no actions, no batch, no
  // metadata files, no page render, no static asset — it can reach nothing a client could not,
  // and nothing heavier than the route it names. A route a plugin serves is reached through the
  // plugin's handler, as a real request reaches it.
  const subRequest = state.request.headers.get(BATCH_ITEM_HEADER) === "1";
  const reserved = subRequest ? null : await dispatchReserved(state);
  if (reserved) return reserved;
  const manifest = await state.app.config.getManifest();
  const metaFile = subRequest ? null : await serveMetadata(state, manifest);
  if (metaFile) return metaFile;
  const localeInfo = resolveLocale(state);
  if (localeInfo) state.ctx.routing = { basePath: state.app.basePath, locale: localeInfo.locale };
  const routingPath = localeInfo ? localeInfo.rest : state.pathname;
  const softNavPost = await stashSoftNavBody(state);
  if (softNavPost instanceof Response) return softNavPost;
  const fromApi = await dispatchApi(state, manifest, routingPath, softNavPost);
  if (fromApi) return fromApi;
  if (subRequest) return await dispatchSubRequestFallback(state);
  const fromPage = dispatchPage(state, manifest, routingPath, localeInfo, softNavPost);
  return await withAppCors(state, fromPage ?? serveFallback(state, manifest, routingPath));
}

/**
 * An error escaped the stages. A cooperative abort (client disconnect / request timeout)
 * is not a server error: don't log it or run onError — the client is gone, or the
 * timeout race has already sent the 503; this response is discarded. Otherwise report
 * to instrumentation, then let the app's onError render the response — a throwing
 * custom error renderer must not escape, so it falls back to the 500.
 */
async function handlePipelineError(state: RequestState, error: unknown): Promise<Response> {
  const { config } = state.app;
  const { ctx, request, pathname, dispatchRouteType } = state;
  if (isAbortError(error) || ctx.signal?.aborted) return new Response(null, { status: 503 });
  await reportRequestError(config, error, request, pathname, {
    routeType: dispatchRouteType,
    renderSource: dispatchRouteType === "render" ? "server-rendering" : undefined,
  });
  if (config.onError) {
    try {
      return await config.onError(error, request);
    } catch (onErrorFailure) {
      console.error("denext: onError handler threw", ctx.requestId, pathname, onErrorFailure);
    }
  }
  if (isThenable(error)) {
    // A component suspended with no Suspense boundary above it (React: an error too). The
    // raw Promise says nothing useful; name the situation and, with DENEXT_DEBUG_SUSPENSE,
    // where `use()` first saw it.
    const origin = (error as { _origin?: string })._origin;
    console.error(
      `denext: unhandled suspension while handling ${ctx.requestId} ${pathname} — a component ` +
        `suspended (use()/lazy) with no <Suspense> boundary above it` +
        (origin ? `\n${origin}` : " (set DENEXT_DEBUG_SUSPENSE=1 to trace the origin)"),
    );
  } else {
    console.error("denext: unhandled error while handling", ctx.requestId, pathname, error);
  }
  return defaultErrorResponse(request, ctx.requestId);
}

/** HTML-escape `text` for an element body. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The response to an error nothing else handled: for a request that takes HTML, a minimal page
 * (as Next.js serves its default error page when there is no `error.tsx` / `global-error.tsx`),
 * else plain text. Neither says anything about the error; the server log has it under the id.
 */
function defaultErrorResponse(request: Request, requestId: string): Response {
  const headers = { "x-request-id": requestId };
  if (!(request.headers.get("accept") ?? "").includes("text/html")) {
    return new Response("Internal Server Error", {
      status: 500,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
  const html = "<!DOCTYPE html>" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>500 — Internal Server Error</title></head><body>" +
    '<div class="denext-error"><h1>500</h1><p>Internal Server Error.</p>' +
    `<p><small>Request id: ${escapeHtml(requestId)}</small></p></div></body></html>`;
  return new Response(html, {
    status: 500,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Run one request through the pipeline. Must run inside the request's async context
 * (`runWithContext`) so cookies()/headers() work in components, handlers and middleware.
 */
export async function runPipeline(
  app: AppRuntime,
  ctx: RequestContext,
  originalRequest: Request,
): Promise<Response> {
  const url = new URL(originalRequest.url);
  const state: RequestState = {
    app,
    ctx,
    request: originalRequest,
    url,
    pathname: url.pathname,
    dispatchRouteType: "render",
  };
  ctx.routing = { basePath: app.basePath };
  try {
    return await dispatch(state);
  } catch (error) {
    return await handlePipelineError(state, error);
  } finally {
    // Drain after() callbacks (and deferred cache invalidations) WITHOUT blocking the
    // response — after() must not delay it. runDeferred swallows every error, so the
    // detached promise can never reject. (On a serverless runtime that freezes the
    // isolate the instant the response is sent, this work is best-effort — the same
    // caveat as the platform's own after().) A STREAMED response is still rendering
    // its Suspense holes when the Response object leaves here; its assembler drains
    // when the body ends instead (`beginStreamedBody`), so an after() registered inside
    // a hole runs too.
    if (!ctx.bodyStreaming) void runDeferred(ctx);
    // Release any ISR single-flight followers waiting on this key (the cache is
    // populated by now if the render was cacheable).
    if (state.releasePageLeader) state.releasePageLeader();
  }
}
