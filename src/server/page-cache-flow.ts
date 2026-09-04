// ISR for page renders: the cache key, serving a hit (with stale-while-revalidate
// background regeneration), single-flight stampede protection, and storing a render.

import type { CachedPage, CacheEntryTiming } from "./cache.ts";
import { pageCacheTiming } from "./cache.ts";
import type { RenderedPage } from "./render-page.ts";
import { renderDocument } from "./document.ts";
import { resolveCsp } from "./csp.ts";
import { warnUnkeyedParamReads } from "./request-context.ts";
import { raceAbort } from "./abort.ts";
import { DEFAULT_REQUEST_TIMEOUT, REGEN_HEADER, REGEN_TOKEN } from "./app-config.ts";
import {
  type CacheState,
  documentOptions,
  htmlResponse,
  type PageRequest,
  servePprShell,
  shellFromCache,
} from "./page-document.ts";

/**
 * In-flight ISR renders, keyed by page cache key. Followers await the leader and
 * re-read the cache instead of rendering in parallel (stampede protection). It
 * only ever coordinates waiting — a live render is never shared across requests.
 */
const pageRenderInFlight = new Map<string, Promise<void>>();

/**
 * Cache keys with a stale-while-revalidate background regeneration in flight, so a
 * burst of stale hits triggers at most one background re-render per key.
 */
const pageRegenInFlight = new Set<string>();

/**
 * Build a stable page cache key from the path and query string. The query params
 * are sorted (by name, then value) so `?a=1&b=2` and `?b=2&a=1` map to ONE cache
 * entry instead of forking it — and so an attacker can't multiply entries (or
 * thrash the in-memory LRU) merely by permuting parameter order. Values are kept
 * verbatim (they legitimately change the render); only their order is normalized.
 *
 * When `allowParams` is given (opt-in, `AppConfig.cacheKeyParams`), only those
 * param names participate in the key — every other param is dropped from the key
 * (but still reaches the render), so high-cardinality junk params can't fork the
 * cache or thrash the LRU. Omitted ⇒ all params participate (default).
 */
export function pageCacheKey(
  pathname: string,
  searchParams: URLSearchParams,
  allowParams?: string[],
): string {
  let entries = [...searchParams.entries()];
  if (allowParams) {
    const allow = new Set(allowParams);
    entries = entries.filter(([name]) => allow.has(name));
  }
  if (entries.length === 0) return pathname;
  // URLSearchParams.sort() orders by name only and keeps insertion order among
  // equal names, so sort explicitly by name then value for a fully stable key.
  entries.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  );
  return `${pathname}?${new URLSearchParams(entries).toString()}`;
}

/**
 * The cache entry for a render of this request: the body, status and timing, plus the
 * tags of any cached data the render read — so `revalidateTag(tag)` purges the page
 * too, not just the data — and any PPR shell fields.
 */
export function pageCacheEntry(
  pr: PageRequest,
  body: string,
  status: number,
  timing: CacheEntryTiming,
  extra: Partial<CachedPage> = {},
): CachedPage {
  const tags = pr.state.ctx.collectedTags;
  return {
    body,
    status,
    path: pr.state.pathname,
    expiresAt: timing.expiresAt,
    staleAt: timing.staleAt,
    tags: tags ? [...tags] : [],
    ...extra,
  };
}

/**
 * Whether a render may be stored for other requests: not when it read a dynamic API
 * (cookies()/headers() — per-request output), and not when it read a non-allowlisted
 * searchParam under `cacheKeyParams` (that value is a per-request signal baked into the
 * body, so caching it would serve it to other requests; dev-warned).
 */
export function mayCacheRender(pr: PageRequest): boolean {
  const { ctx } = pr.state;
  const { cacheKeyParams } = pr.state.app.config;
  if (ctx.usedDynamicApi) return false;
  return !(cacheKeyParams && warnUnkeyedParamReads(ctx, cacheKeyParams));
}

/**
 * Stale-while-revalidate: regenerate `pr.cacheKey` in the background (at most one
 * regen per key) through the app's own handler, marked with the unforgeable regen
 * token. The regen render runs with requestTimeout disabled (it serves no client), so
 * it gets its own hard deadline: on expiry, free the key AND abort the render's
 * cooperative signal. Without this, a hung upstream (`fetch` has no default timeout)
 * would leak the render forever and — because the `.finally` that clears the key never
 * runs — permanently freeze staleness for this key (H2).
 */
function scheduleBackgroundRegen(pr: PageRequest): void {
  const { app, request } = pr.state;
  const { cacheKey } = pr;
  if (pageRegenInFlight.has(cacheKey)) return;
  pageRegenInFlight.add(cacheKey);
  const regenController = new AbortController();
  const regenReq = new Request(request.url, {
    method: "GET",
    headers: new Headers(request.headers),
    signal: regenController.signal,
  });
  regenReq.headers.set(REGEN_HEADER, REGEN_TOKEN);
  const regenDeadline = app.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const timer = regenDeadline > 0
    ? setTimeout(() => {
      pageRegenInFlight.delete(cacheKey); // free the key for a retry
      regenController.abort(); // reclaim the hung render
    }, regenDeadline)
    : undefined;
  if (timer !== undefined) Deno.unrefTimer(timer);
  Promise.resolve()
    .then(() => app.handle(regenReq))
    .catch(() => {})
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      pageRegenInFlight.delete(cacheKey);
    });
}

/**
 * Serve an ISR cache hit. Past `staleAt` the stale render is served now and
 * regenerated in the background. A cached PPR shell (holes) is resumed and streamed
 * with this request's holes and per-request `<head>` — a Flight shell with the tagged
 * page loader, an HTML shell with the plain one; a fully-static cached page is served
 * verbatim, routed through finalize so middleware headers (e.g. an app CSP) override
 * the stored default.
 */
function serveCacheHit(pr: PageRequest, hit: CachedPage): Promise<Response> {
  const stale = hit.staleAt != null && hit.staleAt <= Date.now();
  if (stale) scheduleBackgroundRegen(pr);
  const cacheState: CacheState = stale ? "STALE" : "HIT";
  pr.state.ctx.renderCache = cacheState; // dev render-mode telemetry
  if (hit.holeIds && hit.holeIds.length > 0) {
    const shell = shellFromCache(hit);
    const loader = shell.flight ? pr.pageLoad : pr.state.app.config.load;
    return servePprShell(pr, shell, cacheState, loader);
  }
  return Promise.resolve(
    htmlResponse(pr.state, hit.body, hit.status, hit.csp, { "x-denext-cache": cacheState }),
  );
}

/**
 * Single-flight (stampede protection): if another request is already rendering this
 * key, wait for it and re-read the cache rather than rendering in parallel. A live
 * render is NEVER shared — the leader's render may read cookies() and be per-user; only
 * what it actually cached (provably impersonal) is served. If nothing was cached (the
 * leader's render was dynamic), the follower falls through and renders its own. A
 * background regen is already single-flighted by `pageRegenInFlight` and serves no
 * client, so it takes no leader lock: otherwise a hung regen would pin the lock and block
 * every future foreground MISS and regen for this key (H2). The wait is raced against
 * the follower's own abort (disconnect / timeout) so a hung leader can't pin it.
 */
async function awaitLeaderOrClaim(pr: PageRequest): Promise<Response | null> {
  const { state, cacheKey } = pr;
  const leaderDone = pr.isRegen ? undefined : pageRenderInFlight.get(cacheKey);
  if (leaderDone) {
    await raceAbort(leaderDone, state.ctx.signal);
    state.ctx.signal?.throwIfAborted();
    const retry = await state.app.config.pageCache!.get(cacheKey);
    if (!retry) return null;
    return htmlResponse(state, retry.body, retry.status, retry.csp, { "x-denext-cache": "HIT" });
  }
  if (!pr.isRegen) {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    pageRenderInFlight.set(cacheKey, done);
    state.releasePageLeader = () => {
      pageRenderInFlight.delete(cacheKey);
      release();
    };
  }
  return null;
}

/**
 * ISR read: a cached render when available (impersonal GETs). A background-regeneration
 * request skips the cache read so it always renders fresh and repopulates the entry.
 * Null when this request must render.
 */
export async function serveFromPageCache(pr: PageRequest): Promise<Response | null> {
  if (!pr.cacheable) return null;
  const hit = pr.isRegen ? undefined : await pr.state.app.config.pageCache!.get(pr.cacheKey);
  if (hit) return serveCacheHit(pr, hit);
  return awaitLeaderOrClaim(pr);
}

/**
 * ISR store on the buffered path: cache the rendered document when the route opts in
 * (revalidate/force-static) — but never when the render read a dynamic API or a
 * non-allowlisted searchParam (see {@link mayCacheRender}). The document is built once
 * here so the cached body matches what is served, and the hash-based CSP is computed
 * from those exact bytes so it stays valid on every future cache hit. Null when the
 * route is not cacheable.
 */
export async function cacheAndServeBuffered(
  pr: PageRequest,
  rendered: RenderedPage,
): Promise<Response | null> {
  const { config } = pr.state.app;
  if (!pr.cacheable || rendered.status !== 200 || pr.state.ctx.usedDynamicApi) return null;
  const timing = pageCacheTiming(rendered.config);
  if (timing === null) return null;
  const cachedDoc = renderDocument({
    bodyHtml: rendered.html,
    metadata: rendered.metadata,
    ...documentOptions(pr),
    flight: rendered.flight,
    viewport: rendered.viewport,
  });
  const csp = await resolveCsp(cachedDoc, rendered.config.csp, config.csp);
  const unkeyedLeak = config.cacheKeyParams
    ? warnUnkeyedParamReads(pr.state.ctx, config.cacheKeyParams)
    : false;
  if (!unkeyedLeak) {
    await config.pageCache!.set(
      pr.cacheKey,
      pageCacheEntry(pr, cachedDoc, rendered.status, timing, { csp }),
    );
  }
  return htmlResponse(pr.state, cachedDoc, rendered.status, csp, { "x-denext-cache": "MISS" });
}
