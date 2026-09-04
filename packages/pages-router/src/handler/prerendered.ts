// Serving build-time prerendered SSG pages from disk, with stale-while-revalidate ISR
// through the PageCache for pages that declare `revalidate`.

import { join } from "@std/path";
import { staticPageDir } from "../static-dir.ts";
import type { PageCache } from "@denext/denext/server";
import { type HandlerState, html } from "./shared.ts";

/** A prerendered page's `props.json` (the soft-nav data response + `revalidate`). */
type PrerenderMeta = { revalidate?: number } & Record<string, unknown>;

/** A cached ISR entry (what `PageCache.get` returns). */
type CachedPage = NonNullable<Awaited<ReturnType<PageCache["get"]>>>;

/**
 * Serve a build-time prerendered SSG page from disk, or null if the path wasn't
 * prerendered (→ render on demand). `revalidate` pages go through the PageCache
 * for stale-while-revalidate ISR, seeded from the prerendered file. `regen` renders
 * the page live for a background regeneration.
 */
export async function servePrerendered(
  st: HandlerState,
  pathname: string,
  wantsData: boolean,
  regen: () => Promise<Response>,
): Promise<Response | null> {
  const dir = st.opts.staticDir ? staticPageDir(st.opts.staticDir, pathname) : null;
  if (!dir) return null; // no static dir, or the path would escape it
  let meta: PrerenderMeta;
  try {
    meta = JSON.parse(await Deno.readTextFile(join(dir, "props.json")));
  } catch {
    return null; // not prerendered
  }
  if (wantsData) {
    const { revalidate: _drop, ...data } = meta;
    return Response.json(data);
  }
  let body: string;
  try {
    body = await Deno.readTextFile(join(dir, "index.html"));
  } catch {
    return null;
  }
  const revalidate = typeof meta.revalidate === "number" ? meta.revalidate : undefined;
  const cache = st.opts.pageCache;
  if (!revalidate || !cache) return html(body);
  return await serveIsr(st, cache, pathname, body, revalidate, regen);
}

/**
 * ISR (stale-while-revalidate). The prerendered file is always servable, so a cache
 * backend error must never turn it into a 500 — fall back to the file. A fresh entry is
 * served as-is; a stale one is served while one background regeneration runs; a first
 * serve seeds the cache from the prerendered file (best-effort).
 */
async function serveIsr(
  st: HandlerState,
  cache: PageCache,
  pathname: string,
  body: string,
  revalidate: number,
  regen: () => Promise<Response>,
): Promise<Response> {
  const key = `pr:${pathname}`;
  const now = Date.now();
  let cached: CachedPage | null | undefined;
  try {
    cached = await cache.get(key);
  } catch (err) {
    console.error("@denext/pages-router: ISR cache read failed for", pathname, err);
    return html(body);
  }
  if (cached) {
    if (now < (cached.staleAt ?? Infinity)) return html(cached.body);
    if (!st.regenerating.has(key)) {
      st.regenerating.add(key);
      void regenerate(st, cache, key, pathname, cached, revalidate, regen);
    }
    return html(cached.body);
  }
  try {
    await cache.set(key, {
      body,
      status: 200,
      path: pathname,
      expiresAt: Infinity,
      staleAt: now + revalidate * 1000,
      tags: [],
    });
  } catch (err) {
    console.error("@denext/pages-router: ISR cache seed failed for", pathname, err);
  }
  return html(body);
}

/**
 * Regenerate a stale ISR entry in the background. Only a real page is cached as 200:
 * a redirect/404/500 regen (e.g. the data source started returning notFound) must NOT
 * poison the cache as a 200 blank/error body — keep serving stale and back off. A
 * failed regen also backs off so a sustained failure doesn't re-fire on every request.
 */
async function regenerate(
  st: HandlerState,
  cache: PageCache,
  key: string,
  pathname: string,
  stale: CachedPage,
  revalidate: number,
  regen: () => Promise<Response>,
): Promise<void> {
  const nextStale = Date.now() + revalidate * 1000;
  try {
    const res = await regen();
    const body = res.status === 200 ? await res.text() : stale.body;
    await cache.set(key, { ...stale, body, status: 200, staleAt: nextStale });
  } catch (err) {
    console.error("@denext/pages-router: ISR regen failed for", pathname, err);
    try {
      await cache.set(key, { ...stale, staleAt: nextStale });
    } catch { /* cache down — nothing to do */ }
  } finally {
    st.regenerating.delete(key);
  }
}
