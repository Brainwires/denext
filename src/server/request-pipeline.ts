// The request pipeline: the ordered routing stages one request runs through — path
// canonicalization, config URL rules, middleware, Server Actions, metadata files, i18n,
// API routes, pages, and the 405 / plugin / static / 404 fallbacks — plus the top-level
// error handling. `createApp` wraps this with the per-request context, timeout,
// hardening headers and logging.

import type { RouteManifest } from "../router/manifest.ts";
import { matchApi, matchPage } from "../router/match.ts";
import { handleApi } from "./api.ts";
import { renderRootNotFound } from "./render-page.ts";
import { type RequestContext, runDeferred } from "./request-context.ts";
import { renderDocument } from "./document.ts";
import { resolveCsp } from "./csp.ts";
import { serveStatic } from "./static.ts";
import { redirect } from "./middleware.ts";
import { type PeeledLocale, peelLocale } from "./i18n.ts";
import { fillDestination, matchPattern, safeRedirectLocation } from "./config.ts";
import { handleAction, isActionRequest } from "./action-handler.ts";
import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "./body.ts";
import { serveMetadataFile } from "./metadata-files.ts";
import { requestOrigin } from "./absolute-url.ts";
import { publicEnv, restrictPublicEnv } from "../runtime/public-env.ts";
import { isAbortError } from "./abort.ts";
import { isReadMethod, originOptions, reportRequestError } from "./app-config.ts";
import {
  addInjectedHeader,
  type AppRuntime,
  finalize,
  type RequestState,
  retarget,
  withInjectedHeaders,
} from "./pipeline-state.ts";
import { htmlHeaders, notFound } from "./response-headers.ts";
import { servePage } from "./page-response.ts";

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
    if (canonical !== pathname) return redirect(safeRedirectLocation(canonical) + url.search, 308);
  }
  const isFrameworkPath = pathname.startsWith("/_denext");
  const isFile = /\.[^/]+$/.test(pathname);
  if (isFrameworkPath || isFile || pathname === "/") return null;
  const hasSlash = pathname.endsWith("/");
  const wantSlash = config.trailingSlash === true; // unset = Next's default: no slash
  if (wantSlash && !hasSlash) {
    return redirect(safeRedirectLocation(pathname + "/") + url.search, 308);
  }
  if (!wantSlash && hasSlash) {
    return redirect(safeRedirectLocation(pathname.replace(/\/+$/, "")) + url.search, 308);
  }
  return null;
}

/** Config redirects (denext.config): first match wins (permanent → 308, else 307). */
function applyRedirectRules(state: RequestState): Response | null {
  for (const { pattern, rule } of state.app.rules().redirects) {
    const params = matchPattern(pattern, state.pathname);
    if (params) {
      return redirect(
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
  state.request = new Request(url.toString(), state.request);
}

/**
 * The remaining config URL rules: header rules accumulate onto matching responses (via
 * the injected headers); the first matching rewrite internally routes as its
 * destination (no client redirect).
 */
function applyPathRules(state: RequestState): void {
  stripBasePath(state);
  const rules = state.app.rules();
  for (const { pattern, rule } of rules.headers) {
    if (!matchPattern(pattern, state.pathname)) continue;
    for (const { key, value } of rule.headers) addInjectedHeader(state, key, value);
  }
  for (const { pattern, rule } of rules.rewrites) {
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
  const outcome = await runner(state.request);
  state.dispatchRouteType = "render";
  if (outcome.type === "response") return withInjectedHeaders(state, outcome.response);
  if (outcome.type === "rewrite") {
    state.request = new Request(outcome.url, state.request);
    state.url = new URL(state.request.url);
    state.pathname = state.url.pathname;
  }
  if (outcome.requestHeaders) {
    state.request = new Request(state.request, { headers: outcome.requestHeaders });
  }
  if (outcome.headers) {
    for (const [k, v] of outcome.headers) addInjectedHeader(state, k, v);
  }
  return null;
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
    maxBodyBytes: config.actionMaxBodyBytes,
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
  );
  return metaFile ? finalize(state, metaFile) : null;
}

/**
 * i18n: peel an optional locale prefix off the path. Matching runs against the stripped
 * path; the locale is merged into route params. With `i18n.domains`, the locale for an
 * unprefixed path depends on the host — resolved from the request's *trusted* host
 * (never a raw Host header), and only paid for when domain routing is configured.
 */
function resolveLocale(state: RequestState): PeeledLocale | null {
  const { config } = state.app;
  if (!config.i18n) return null;
  const localeHost = config.i18n.domains
    ? new URL(requestOrigin(state.request, originOptions(config))).host
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
  const apiRes = await handleApi(api, state.request, state.app.config.load);
  const fallThroughToPage = apiRes.status === 405 && isReadMethod(state.request) &&
    matchPage(manifest, routingPath, { soft: false }) !== null;
  if (!fallThroughToPage) return finalize(state, apiRes);
  state.dispatchRouteType = "render"; // handed off to the page render
  return null;
}

/** Pages: GET/HEAD, plus a soft-nav POST carrying an over-large render payload. */
function dispatchPage(
  state: RequestState,
  manifest: RouteManifest,
  routingPath: string,
  localeInfo: PeeledLocale | null,
  softNavPost: boolean,
): Promise<Response> | null {
  if (!isReadMethod(state.request) && !softNavPost) return null;
  // Soft (client) navigations carry x-denext-nav; enables interception.
  const soft = state.request.headers.get("x-denext-nav") === "1";
  const matched = matchPage(manifest, routingPath, { soft });
  if (!matched) return null;
  return servePage(state, { manifest, matched, localeInfo, soft });
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
    publicEnv: restrictPublicEnv(publicEnv(), config.publicEnvKeys),
  });
  const csp = await resolveCsp(doc, undefined, config.csp);
  const body = state.request.method === "HEAD" ? null : doc;
  return finalize(state, new Response(body, { status, headers: htmlHeaders(csp) }));
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
  if (config.publicDir && isReadMethod(request)) {
    const asset = await serveStatic(config.publicDir, pathname);
    if (asset) return finalize(state, asset);
  }
  if (isReadMethod(request)) return serveNotFoundPage(state, manifest);
  return finalize(state, notFound(pathname));
}

/** The routing stages, in order; each either produces the response or hands on. */
async function dispatch(state: RequestState): Promise<Response> {
  const redirected = canonicalizePath(state) ?? applyRedirectRules(state);
  if (redirected) return redirected;
  applyPathRules(state);
  const fromMiddleware = await runMiddleware(state);
  if (fromMiddleware) return fromMiddleware;
  if (isActionRequest(state.request, state.pathname)) return dispatchAction(state);
  const manifest = await state.app.config.getManifest();
  const metaFile = await serveMetadata(state, manifest);
  if (metaFile) return metaFile;
  const localeInfo = resolveLocale(state);
  const routingPath = localeInfo ? localeInfo.rest : state.pathname;
  const softNavPost = await stashSoftNavBody(state);
  if (softNavPost instanceof Response) return softNavPost;
  const fromApi = await dispatchApi(state, manifest, routingPath, softNavPost);
  if (fromApi) return fromApi;
  const fromPage = await dispatchPage(state, manifest, routingPath, localeInfo, softNavPost);
  if (fromPage) return fromPage;
  return serveFallback(state, manifest, routingPath);
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
  console.error("denext: unhandled error while handling", ctx.requestId, pathname, error);
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "x-request-id": ctx.requestId },
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
  try {
    return await dispatch(state);
  } catch (error) {
    return await handlePipelineError(state, error);
  } finally {
    // Drain after() callbacks (and deferred cache invalidations) WITHOUT blocking the
    // response — after() must not delay it. runDeferred swallows every error, so the
    // detached promise can never reject. (On a serverless runtime that freezes the
    // isolate the instant the response is sent, this work is best-effort — the same
    // caveat as the platform's own after().)
    void runDeferred(ctx);
    // Release any ISR single-flight followers waiting on this key (the cache is
    // populated by now if the render was cacheable).
    if (state.releasePageLeader) state.releasePageLeader();
  }
}
