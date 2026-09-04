// Cache Components / PPR (experimental, gated): render a request-independent static
// shell — cached once — with any dynamic subtrees (cookies()/headers() behind a
// Suspense) as per-request holes spliced in on every request.

import type { CacheEntryTiming } from "./cache.ts";
import { pageCacheTiming } from "./cache.ts";
import {
  type PrerenderedFlightPage,
  type PrerenderedPage,
  prerenderPage,
  prerenderPageFlight,
} from "./render-page.ts";
import { renderDocument } from "./document.ts";
import { resolveCsp } from "./csp.ts";
import { isAbortError } from "./abort.ts";
import {
  documentOptions,
  htmlResponse,
  type PageRequest,
  servePprShell,
  shellFromPrerender,
} from "./page-document.ts";
import { mayCacheRender, pageCacheEntry } from "./page-cache-flow.ts";

type Prerendered = PrerenderedPage | PrerenderedFlightPage;

/** Prerender the page's static shell; any prerender complication → normal render. */
function prerenderShell(pr: PageRequest): Promise<Prerendered | null> {
  const { request, ctx } = pr.state;
  const opts = { messages: pr.messages, signal: ctx.signal };
  const run = pr.useFlight
    ? prerenderPageFlight(pr.page, request, pr.pageLoad, opts)
    : prerenderPage(pr.page, request, pr.pageLoad, opts);
  return run.catch((err) => {
    if (isAbortError(err)) throw err;
    return null;
  });
}

/** The cache-entry fields a Flight shell carries beyond the body (its tree, islands, signals). */
function flightShellFields(pre: Prerendered, useFlight: boolean) {
  if (!useFlight) return {};
  const { flightShell, flightIslands, flightSignalState } = pre as PrerenderedFlightPage;
  return { flightShell, flightIslands, flightSignalState };
}

/** The inline Flight payload a fully-static Flight shell document embeds. */
function flightDocumentFields(pre: Prerendered, useFlight: boolean) {
  if (!useFlight) return {};
  const { flightShell, flightIslands, flightSignalState } = pre as PrerenderedFlightPage;
  return {
    flight: flightShell,
    islands: flightIslands.length > 0 ? flightIslands : undefined,
    signalState: Object.keys(flightSignalState).length > 0 ? flightSignalState : undefined,
  };
}

/**
 * A shell WITH holes: cache the request-independent shell BODY (the head + holes are
 * rebuilt per request; the head extras/title let a later hit rebuild the head) — plus,
 * for a Flight route, its Flight payload — and stream it for THIS request. The tags
 * stored are those the static shell accrued (its `use cache` islands), before the
 * per-request hole render adds its own.
 */
async function serveShellWithHoles(
  pr: PageRequest,
  pre: Prerendered,
  timing: CacheEntryTiming,
): Promise<Response> {
  await pr.state.app.config.pageCache!.set(
    pr.cacheKey,
    pageCacheEntry(pr, pre.shellBody, 200, timing, {
      holeIds: pre.holeIds,
      routeCsp: pre.config.csp,
      headExtras: pre.headExtras,
      inTreeTitle: pre.inTreeTitle,
      ...flightShellFields(pre, pr.useFlight),
    }),
  );
  return servePprShell(pr, shellFromPrerender(pre, pr.useFlight), "MISS", pr.pageLoad);
}

/**
 * A fully-static shell (no holes): its metadata has no dynamic reads, so render + cache
 * the whole document (a Flight route's tree/islands/signal-state tail emitted inline)
 * and serve it verbatim. Backstop: a no-holes "static" shell that nonetheless read a
 * dynamic API (e.g. a `use cache` body that reads cookies — which now throws, but
 * defense-in-depth) is request-specific — served to THIS request, never cached for
 * others. Mirrors the normal path's guard.
 */
async function serveStaticShell(
  pr: PageRequest,
  pre: Prerendered,
  timing: CacheEntryTiming,
): Promise<Response> {
  const { config } = pr.state.app;
  const shellDoc = renderDocument({
    bodyHtml: pre.shellBody,
    metadata: pre.metadata,
    viewport: pre.viewport,
    ...documentOptions(pr),
    ...flightDocumentFields(pre, pr.useFlight),
  });
  const csp = await resolveCsp(shellDoc, pre.config.csp, config.csp);
  if (mayCacheRender(pr)) {
    await config.pageCache!.set(pr.cacheKey, pageCacheEntry(pr, shellDoc, 200, timing, { csp }));
  }
  return htmlResponse(pr.state, shellDoc, 200, csp, { "x-denext-cache": "MISS" });
}

/**
 * Cache Components / PPR for a page that is ALREADY cacheable (opted in via
 * revalidate/force-static). This lifts the all-or-nothing dynamic disqualification:
 * such a page was previously not cached at all. Flight routes get the same
 * request-independent-shell + per-request-holes model, with the shell's Flight tree,
 * islands and signal state cached alongside the body, so a client-island route can be
 * partially prerendered — the "on by default" unlock for real apps. Un-prerenderable
 * (fully dynamic) pages and non-cacheable requests fall through to the normal render
 * (null).
 */
export async function servePrerendered(pr: PageRequest): Promise<Response | null> {
  if (!pr.state.app.config.cacheComponents || !pr.cacheable) return null;
  const pre = await prerenderShell(pr);
  if (!pre || pre.dynamic) return null;
  const timing = pageCacheTiming(pre.config);
  if (timing === null) return null;
  return pre.holeIds.length > 0
    ? serveShellWithHoles(pr, pre, timing)
    : serveStaticShell(pr, pre, timing);
}
