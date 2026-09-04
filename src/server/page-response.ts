// Serving a matched page end to end: ISR cache → PPR shell → streamed or buffered
// render → soft-navigation payload / cached document / buffered document.

import type { RouteManifest } from "../router/manifest.ts";
import type { PageMatch } from "../router/match.ts";
import type { PeeledLocale } from "./i18n.ts";
import { resolveMessages } from "./i18n.ts";
import {
  buildPageContext,
  type RenderedPage,
  renderGlobalError,
  renderPage,
} from "./render-page.ts";
import { type IsoNavPayload, renderDocument, serializeFlightNav } from "./document.ts";
import { resolveCsp } from "./csp.ts";
import { isRedirect } from "../runtime/error-boundary.ts";
import { safeRedirectLocation } from "./config.ts";
import { isAbortError } from "./abort.ts";
import { isRegenRequest, reportRequestError } from "./app-config.ts";
import { finalize, type RequestState } from "./pipeline-state.ts";
import { resolveFlightLoader } from "./flight-routing.ts";
import {
  augmentPageMetadata,
  documentOptions,
  htmlResponse,
  navData,
  type PageRequest,
  renderOptions,
  renderSourceOf,
  reportBoundaryErrors,
  titleOf,
} from "./page-document.ts";
import { cacheAndServeBuffered, pageCacheKey, serveFromPageCache } from "./page-cache-flow.ts";
import { servePrerendered } from "./page-prerender.ts";
import { serveStreamed } from "./page-stream.ts";

/** What the routing stage hands over once a page matched. */
export interface MatchedPageRequest {
  manifest: RouteManifest;
  matched: PageMatch;
  localeInfo: PeeledLocale | null;
  /** A soft (client) navigation (`x-denext-nav`). */
  soft: boolean;
}

/** Soft-navigation JSON payloads are never cached and keyed on the nav header. */
const SOFT_NAV_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  // L9: this URL yields JSON to a soft nav but full HTML to a hard request — key any
  // intermediary cache on the nav header (belt-and-suspenders atop no-store) so the
  // variants never cross.
  "vary": "x-denext-nav",
};

/**
 * Resolve everything the page stages share: the locale + message catalog (only when
 * catalogs are configured, so non-i18n apps stay untouched), the Flight decision and
 * loader, and the ISR key/eligibility.
 */
async function preparePageRequest(
  state: RequestState,
  { manifest, matched, localeInfo, soft }: MatchedPageRequest,
): Promise<PageRequest> {
  const { config } = state.app;
  const page = localeInfo
    ? { route: matched.route, params: { ...matched.params, locale: localeInfo.locale } }
    : matched;
  const locale = localeInfo?.locale ?? config.i18n?.defaultLocale ?? "";
  const messages = config.i18n?.messages ? resolveMessages(config.i18n, locale) : undefined;
  const { useFlight, pageLoad } = await resolveFlightLoader(config, page.route, manifest);
  return {
    state,
    manifest,
    page,
    localeInfo,
    locale,
    messages,
    soft,
    useFlight,
    pageLoad,
    isRegen: isRegenRequest(state.request),
    cacheable: !!config.pageCache && !soft && state.request.method === "GET",
    cacheKey: pageCacheKey(state.pathname, state.url.searchParams, config.cacheKeyParams),
    boundaryErrors: [],
  };
}

/**
 * A render that threw. A cooperative abort (client disconnect / timeout) is not an app
 * error — it unwinds to the top-level handler. `redirect()` from a server component
 * issues an HTTP redirect. A global-error.tsx replaces the whole tree on an uncaught
 * error — handled (and reported) here, since the top-level catch won't see it. Anything
 * else rethrows so the top-level catch reports it.
 */
async function recoverPageError(
  pr: PageRequest,
  pageError: unknown,
): Promise<RenderedPage | Response> {
  const { config } = pr.state.app;
  if (isAbortError(pageError)) throw pageError;
  if (isRedirect(pageError)) {
    return finalize(
      pr.state,
      new Response(null, {
        status: pageError.status,
        headers: { location: safeRedirectLocation(pageError.url) },
      }),
    );
  }
  const ge = await renderGlobalError(pr.manifest, config.load, pageError);
  if (!ge) throw pageError;
  await reportRequestError(config, pageError, pr.state.request, pr.page.route.routePath, {
    routeType: "render",
    renderSource: renderSourceOf(pr),
  });
  return ge;
}

/**
 * Flight soft-navigation: a client nav to a Flight route gets the JSON Flight payload
 * instead of a full HTML document — the client parses it through the app-wide client
 * registry and reconciles the retained root in place (no HTML parse, no bundle re-run).
 * Falls through (null) when there is no Flight payload (e.g. a 404 / global-error
 * render), which the client handles as an ordinary HTML soft-nav. Lazy islands + signal
 * state ride along so a soft nav can render/wire them.
 */
function flightNavResponse(pr: PageRequest, rendered: RenderedPage): Response | null {
  const isFlightNav = pr.soft && pr.useFlight && rendered.flight !== undefined &&
    pr.state.request.method === "GET";
  if (!isFlightNav) return null;
  const payload = serializeFlightNav({
    flight: rendered.flight!,
    title: titleOf(rendered.metadata),
    data: navData(pr),
    islands: rendered.islands,
    signalState: rendered.signalState,
  });
  return finalize(
    pr.state,
    new Response(payload, {
      status: rendered.status,
      headers: { ...SOFT_NAV_HEADERS, "x-denext-flight": "1" },
    }),
  );
}

/**
 * Isomorphic soft-navigation: a route WITH a client entry but no Flight boundary
 * re-renders from its re-run bundle on a soft nav, so the SSR `<body>` is discarded by
 * the client. Send only what it uses — title, hydration data, the route's stylesheet
 * hrefs, and the entry src — as a compact JSON payload instead of the full document.
 */
function isoNavResponse(pr: PageRequest, rendered: RenderedPage): Response | null {
  const { config } = pr.state.app;
  const isoEntry = pr.soft && !pr.useFlight && pr.state.request.method === "GET"
    ? config.clientEntryFor?.(pr.page.route)
    : undefined;
  if (!isoEntry) return null;
  const payload: IsoNavPayload = {
    title: titleOf(rendered.metadata),
    data: navData(pr),
    entry: isoEntry,
    styles: config.styleHrefsFor?.(pr.page.route),
  };
  return finalize(
    pr.state,
    new Response(JSON.stringify(payload), {
      status: rendered.status,
      headers: { ...SOFT_NAV_HEADERS, "x-denext-iso": "1" },
    }),
  );
}

/**
 * The buffered HTML document. Two per-request response shapes must never be stored by a
 * shared cache and served to another visitor: a soft-nav (prefetch) variant (cf.
 * CVE-2023-46298), and a DYNAMIC render that read cookies()/headers() — per-user, so it
 * needs `no-store` + `Vary: Cookie` (M1). HEAD gets the same headers with no body.
 */
async function bufferedResponse(pr: PageRequest, rendered: RenderedPage): Promise<Response> {
  const doc = renderDocument({
    bodyHtml: rendered.html,
    metadata: rendered.metadata,
    ...documentOptions(pr),
    flight: rendered.flight,
    islands: rendered.islands,
    signalState: rendered.signalState,
    viewport: rendered.viewport,
  });
  const csp = await resolveCsp(doc, rendered.config.csp, pr.state.app.config.csp);
  const dynamic = pr.state.ctx.usedDynamicApi === true;
  const navHeaders = (pr.soft || dynamic)
    ? {
      "cache-control": "private, no-store",
      ...(dynamic ? { vary: "x-denext-nav, Cookie" } : {}),
    }
    : undefined;
  const body = pr.state.request.method === "HEAD" ? null : doc;
  return htmlResponse(pr.state, body, rendered.status, csp, navHeaders);
}

/** Turn a completed render into its response: soft-nav payload, cached document, or buffered document. */
async function serveRendered(pr: PageRequest, rendered: RenderedPage): Promise<Response> {
  await reportBoundaryErrors(pr, renderSourceOf(pr));
  augmentPageMetadata(pr, rendered.metadata);
  const nav = flightNavResponse(pr, rendered) ?? isoNavResponse(pr, rendered);
  if (nav) return nav;
  return (await cacheAndServeBuffered(pr, rendered)) ?? bufferedResponse(pr, rendered);
}

/**
 * Render the page: compose the tree once (metadata/config resolved) so streaming vs
 * buffering costs no re-compose, stream it when streaming applies, else render buffered.
 * `onCaughtError` is wired at compose time because buildPageContext creates the error.tsx
 * ErrorBoundary that carries it.
 */
async function renderAndServe(pr: PageRequest): Promise<Response> {
  const { request } = pr.state;
  let outcome: RenderedPage | Response;
  try {
    const prepared = await buildPageContext(pr.page, request, pr.pageLoad, renderOptions(pr));
    const streamed = await serveStreamed(pr, prepared);
    if (streamed) return streamed;
    outcome = await renderPage(pr.page, request, pr.pageLoad, renderOptions(pr), prepared);
  } catch (pageError) {
    outcome = await recoverPageError(pr, pageError);
  }
  if (outcome instanceof Response) return outcome;
  return serveRendered(pr, outcome);
}

/** Serve a matched page (GET/HEAD, or a soft-nav POST carrying an over-large render payload). */
export async function servePage(state: RequestState, match: MatchedPageRequest): Promise<Response> {
  const pr = await preparePageRequest(state, match);
  // When the key is narrowed, record which searchParams the render reads so a
  // whole-body-cached render can dev-warn if it baked in a dropped param.
  if (pr.cacheable && state.app.config.cacheKeyParams) state.ctx.trackParamReads = true;
  const cached = await serveFromPageCache(pr);
  if (cached) return cached;
  const prerendered = await servePrerendered(pr);
  if (prerendered) return prerendered;
  return renderAndServe(pr);
}
