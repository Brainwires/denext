// Data cache, request memoization, and Incremental Static Regeneration (ISR).
//
//   cache(fn)            — memoize fn for the duration of a single request
//   unstable_cache(fn)   — cross-request cache with TTL + tags
//   revalidateTag(tag)   — purge cached data/pages carrying that tag
//   revalidatePath(path) — purge the cached render of a path
//   PageCache            — the prod server's rendered-page ISR store
//
// The default backing store is in-memory and process-local. A multi-instance
// deployment can inject a shared store (Deno KV, Redis, …) via
// {@linkcode setCacheStore} so ISR renders and cached data are shared across
// replicas and `revalidateTag`/`revalidatePath` reach every instance. Time is
// read via Date.now(); a shared store assumes a shared wall clock.

import { currentContext } from "./request-context.ts";
import type { SegmentConfig } from "./segment-config.ts";

const now = (): number => Date.now();

/**
 * Memoize `fn` for the duration of the current request: repeated calls with the
 * same arguments return the first computed value (React's `cache`). Outside a
 * request the function runs uncached. Define the wrapper once (e.g. at module
 * scope) so its identity is stable.
 *
 * @param fn The function to memoize per request.
 * @returns A wrapper with the same signature.
 */
export function cache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const ctx = currentContext();
    if (!ctx) return fn(...args);
    let perFn = ctx.memo.get(fn) as Map<string, R> | undefined;
    if (!perFn) {
      perFn = new Map();
      ctx.memo.set(fn, perFn);
    }
    const key = safeKey(args);
    if (perFn.has(key)) return perFn.get(key)!;
    const value = fn(...args);
    perFn.set(key, value);
    return value;
  };
}

// ---- Cache store (pluggable backend) --------------------------------------

/** A cached data entry (the value returned by an {@link unstable_cache} loader). */
export interface DataEntry {
  /** The cached value. */
  value: unknown;
  /** Epoch ms when the entry goes stale, or Infinity for no expiry. */
  expiresAt: number;
  /** Tags for targeted invalidation via {@link revalidateTag}. */
  tags: string[];
}

/**
 * The pluggable backend behind denext's data cache and page (ISR) cache.
 *
 * The default implementation is in-memory and process-local. Inject a store
 * backed by a shared cache (Deno KV via {@linkcode denoKvCacheStore}, Redis,
 * etc.) with {@linkcode setCacheStore} so cached data and rendered pages are
 * shared across replicas and invalidation reaches every instance.
 *
 * Methods may return synchronously or as a Promise; denext always awaits them.
 * `get*` must return only **fresh** entries — an implementation is responsible
 * for treating an expired `expiresAt` as a miss (and may evict it).
 */
export interface CacheStore {
  /** Return a fresh data entry for `key`, or undefined if missing/stale. */
  getData(key: string): DataEntry | undefined | Promise<DataEntry | undefined>;
  /** Store a data entry under `key`. */
  setData(key: string, entry: DataEntry): void | Promise<void>;
  /** Return a fresh cached page for `key`, or undefined if missing/stale. */
  getPage(key: string): CachedPage | undefined | Promise<CachedPage | undefined>;
  /** Store a cached page under `key`. */
  setPage(key: string, page: CachedPage): void | Promise<void>;
  /** Purge every data entry and page carrying `tag`. */
  deleteByTag(tag: string): void | Promise<void>;
  /** Purge every cached page rendered for `path` (an exact pathname). */
  deleteByPath(path: string): void | Promise<void>;
}

// Bound the in-memory caches so high-cardinality keys (e.g. many distinct query
// strings) cannot grow them without limit. Map insertion order gives us cheap
// LRU: on a hit we re-insert to mark recency; on overflow we drop the oldest.
const DATA_CACHE_MAX = 1000;
const PAGE_CACHE_MAX = 1000;
// A byte budget on cached pages as well as the entry count: a rendered page can
// be large, so a few hundred big renders could pin far more memory than the
// 1000-entry LRU implies. Evict the LRU until BOTH budgets hold (~64 MB default).
const PAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// Proactively drop hard-expired entries at most this often, so a workload of
// short-TTL keys that are written once and never re-read doesn't retain them
// (getData/getPage evict on access, but only for keys that are read again).
const SWEEP_INTERVAL = 30_000;

/** Approximate retained bytes of a cached page (the body dominates). */
function pageBytes(p: CachedPage): number {
  return p.body.length + (p.csp ? p.csp.length : 0);
}

/** Evict the least-recently-used entry when a Map exceeds `max`. */
function evictLru(map: Map<string, unknown>, max: number): void {
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** The default per-process, in-memory {@link CacheStore}. */
export function inMemoryCacheStore(): CacheStore {
  const data = new Map<string, DataEntry>();
  const pages = new Map<string, CachedPage>();
  let pageByteTotal = 0;
  let lastSweep = now();

  // Return a fresh data entry (touching it for LRU) or undefined, evicting stale.
  function freshData(key: string): DataEntry | undefined {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    data.delete(key); // re-insert to mark most-recently-used
    data.set(key, e);
    return e;
  }

  // Delete a page, keeping the running byte total in sync.
  function deletePage(key: string): void {
    const e = pages.get(key);
    if (e) {
      pageByteTotal -= pageBytes(e);
      pages.delete(key);
    }
  }

  function freshPage(key: string): CachedPage | undefined {
    const e = pages.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= now()) {
      deletePage(key);
      return undefined;
    }
    pages.delete(key); // re-insert to mark most-recently-used
    pages.set(key, e);
    return e;
  }

  // Drop hard-expired entries in bulk, but only occasionally (bounds the cost).
  function maybeSweep(): void {
    const t = now();
    if (t - lastSweep < SWEEP_INTERVAL) return;
    lastSweep = t;
    for (const [k, e] of data) {
      if (e.expiresAt !== Infinity && e.expiresAt <= t) data.delete(k);
    }
    for (const [k, e] of pages) {
      if (e.expiresAt !== Infinity && e.expiresAt <= t) deletePage(k);
    }
  }

  return {
    getData: (key) => freshData(key),
    setData: (key, entry) => {
      data.set(key, entry);
      evictLru(data, DATA_CACHE_MAX);
      maybeSweep();
    },
    getPage: (key) => freshPage(key),
    setPage: (key, page) => {
      const prev = pages.get(key);
      if (prev) pageByteTotal -= pageBytes(prev);
      pages.set(key, page);
      pageByteTotal += pageBytes(page);
      // Evict oldest until within both the count and byte budgets. Never evict
      // the sole remaining entry (a single oversize page is still served).
      while (
        (pages.size > PAGE_CACHE_MAX || pageByteTotal > PAGE_CACHE_MAX_BYTES) &&
        pages.size > 1
      ) {
        const oldest = pages.keys().next().value;
        if (oldest === undefined) break;
        deletePage(oldest);
      }
      maybeSweep();
    },
    deleteByTag: (tag) => {
      for (const [k, e] of data) if (e.tags.includes(tag)) data.delete(k);
      for (const [k, e] of pages) if (e.tags.includes(tag)) deletePage(k);
    },
    deleteByPath: (path) => {
      for (const [k, e] of pages) if (e.path === path) deletePage(k);
    },
  };
}

let currentCacheStore: CacheStore = inMemoryCacheStore();

/**
 * Replace the {@link CacheStore} backing the data cache and page (ISR) cache.
 * Use this to share cached data and rendered pages across instances — back it
 * with {@linkcode denoKvCacheStore} or a Redis adapter so a render or data
 * entry produced on one replica is served by another, and `revalidateTag`/
 * `revalidatePath` invalidate every instance.
 *
 * @param store The store to use for all subsequent cache operations.
 */
export function setCacheStore(store: CacheStore): void {
  currentCacheStore = store;
}

/**
 * Probe the active {@link CacheStore} for reachability with a guarded no-op read
 * (returns `false` if the store is unreachable). The health endpoint uses this to
 * report cache status without ever throwing.
 *
 * @returns `true` if the store responded, `false` if it errored.
 */
export async function cacheStoreHealthy(): Promise<boolean> {
  try {
    await currentCacheStore.getData("__denext:health");
    return true;
  } catch {
    return false;
  }
}

/** Record `tags` on the current render so the page cache can inherit them. */
function collectTags(tags: string[]): void {
  if (tags.length === 0) return;
  const ctx = currentContext();
  if (!ctx) return;
  ctx.collectedTags ??= new Set<string>();
  for (const t of tags) ctx.collectedTags.add(t);
}

// The cache is best-effort: a backing-store error (e.g. a Deno KV outage, or a
// value exceeding KV's size limit) must never fail a request — reads fall
// through to a live render and writes are skipped. Errors are logged, throttled
// so a sustained outage cannot flood stdout.
let lastCacheErrorLog = 0;
function logCacheError(op: string, err: unknown): void {
  const t = now();
  if (t - lastCacheErrorLog < 1000) return; // at most one line per second
  lastCacheErrorLog = t;
  console.error(
    `denext: cache store ${op} failed (serving uncached):`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * Apply a tag/path invalidation to the active store, best-effort. When a request
 * is in flight, the (possibly async) invalidation is also registered on the
 * request's deferred queue so it is drained before the isolate can be reclaimed
 * — a serverless runtime may freeze the isolate the moment the response is sent,
 * which would otherwise drop an un-awaited KV delete.
 */
function invalidate(kind: "tag" | "path", value: string): Promise<void> {
  const raw = kind === "tag"
    ? currentCacheStore.deleteByTag(value)
    : currentCacheStore.deleteByPath(value);
  const p = Promise.resolve(raw).catch((err) =>
    logCacheError(kind === "tag" ? "deleteByTag" : "deleteByPath", err)
  );
  const ctx = currentContext();
  if (ctx) ctx.deferred.push(() => p);
  return p;
}

// ---- Cross-request data cache ---------------------------------------------

/** Options accepted by {@link unstable_cache}. */
export interface CacheOptions {
  /** Seconds until the entry revalidates, or `false`/omitted for no expiry. */
  revalidate?: number | false;
  /** Tags for targeted invalidation via {@link revalidateTag}. */
  tags?: string[];
}

/**
 * Wrap an async data-loading function in a cross-request cache with an optional
 * TTL and tags (Next.js `unstable_cache`). Results are keyed by `keyParts` plus
 * the call arguments. Tags propagate to the enclosing page render, so
 * {@link revalidateTag} purges both the data and any page that read it.
 *
 * @param fn The loader to cache.
 * @param keyParts Extra key segments distinguishing this cache from others.
 * @param options TTL and tags.
 * @returns A wrapper returning cached (or freshly computed) results.
 */
export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R,
  keyParts: string[] = [],
  options: CacheOptions = {},
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const key = safeKey([keyParts, args]);
    const tags = options.tags ?? [];
    // Tag the enclosing render whether or not the data itself is a cache hit.
    collectTags(tags);
    let hit: DataEntry | undefined;
    try {
      hit = await currentCacheStore.getData(key);
    } catch (err) {
      logCacheError("getData", err); // treat a store error as a miss
    }
    if (hit) return hit.value as R;
    // Single-flight: coalesce concurrent misses for the same key so the loader
    // runs once under a cold-cache stampede instead of once per request.
    const inFlight = dataInFlight.get(key);
    if (inFlight) return await inFlight as R;
    const compute = (async () => {
      const value = await fn(...args);
      try {
        await currentCacheStore.setData(key, {
          value,
          expiresAt: ttlToExpiry(options.revalidate),
          tags,
        });
      } catch (err) {
        logCacheError("setData", err); // couldn't cache; still return the value
      }
      return value;
    })();
    dataInFlight.set(key, compute);
    try {
      return await compute as R;
    } finally {
      dataInFlight.delete(key); // clear on both fulfil and reject
    }
  };
}

/** In-flight loader promises for {@link unstable_cache}, keyed by cache key. */
const dataInFlight = new Map<string, Promise<unknown>>();

// Inner memoized fetch: caches the response text keyed on its arguments.
const cachedFetchInner: (
  input: string | URL,
  options?: RequestInit,
) => Promise<string> = unstable_cache(
  async (input: string | URL, options?: RequestInit) => {
    const res = await fetch(input, options);
    return await res.text();
  },
  ["denext:cachedFetch"],
);

/**
 * Fetch `input` and cache the response body across requests (a small
 * `fetch`-with-caching helper). Returns the cached text on a hit.
 *
 * @param input The URL to fetch.
 * @param options Request options plus TTL and tags for the cached body.
 * @returns The response body text (from cache on a hit).
 */
export const cachedFetch = async (
  input: string | URL,
  options?: CacheOptions & RequestInit,
): Promise<string> => {
  // The cache key is derived from the arguments via JSON.stringify. A non-string
  // body (Blob / FormData / ArrayBuffer / URLSearchParams / stream) serializes to
  // "{}", so DIFFERENT such bodies to the same URL would collide onto one cache
  // entry — response-body cache confusion (cf. Next.js CVE-2026-64648/64647).
  // Buffer it to bytes first: a Uint8Array serializes distinctly, so the key
  // reflects the exact body, and the buffered bytes are what we actually send.
  if (options && options.body != null && typeof options.body !== "string") {
    const bytes = new Uint8Array(await new Response(options.body as BodyInit).arrayBuffer());
    options = { ...options, body: bytes };
  }
  return cachedFetchInner(input, options);
};

// ---- Automatic fetch() caching (uncached by default) -----------------------

/** RequestInit plus Next.js's `next: { revalidate, tags }` cache directive. */
type FetchCacheInit = RequestInit & {
  next?: { revalidate?: number | false; tags?: string[] };
};

/** A cached HTTP response: enough to reconstruct a real {@link Response}. */
interface CachedResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

const responseFrom = (c: CachedResponse): Response =>
  new Response(c.body, { status: c.status, headers: new Headers(c.headers) });

/** The un-patched global fetch, captured by {@link installFetchCache}. */
let originalFetch: typeof fetch | null = null;

/** Fetch `input`, caching its status/headers/body across requests, single-flighted. */
async function cachedResponse(
  input: RequestInfo | URL,
  init: FetchCacheInit | undefined,
  revalidate: number | false,
  tags: string[],
): Promise<Response> {
  collectTags(tags);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const key = safeKey(["denext:fetch", url, tags]);
  const store = currentCacheStore;
  const read = async (): Promise<Response | undefined> => {
    try {
      const hit = await store.getData(key);
      if (hit) return responseFrom(hit.value as CachedResponse);
    } catch (err) {
      logCacheError("getData", err);
    }
    return undefined;
  };
  const first = await read();
  if (first) return first;
  // Coalesce concurrent misses for the same key (stampede protection).
  const existing = dataInFlight.get(key);
  if (existing) {
    await existing.catch(() => {});
    const retry = await read();
    if (retry) return retry;
  }
  const compute = (async (): Promise<CachedResponse> => {
    const res = await originalFetch!(input, init);
    const value: CachedResponse = {
      status: res.status,
      headers: [...res.headers],
      body: await res.text(),
    };
    try {
      await store.setData(key, { value, expiresAt: ttlToExpiry(revalidate), tags });
    } catch (err) {
      logCacheError("setData", err);
    }
    return value;
  })();
  dataInFlight.set(key, compute);
  try {
    return responseFrom(await compute);
  } finally {
    dataInFlight.delete(key);
  }
}

/**
 * Install denext's automatic `fetch()` caching (idempotent, process-wide). A bare
 * `fetch()` is passed through **uncached** — the secure default, so an
 * authenticated or per-user response is never accidentally shared. A **GET** given
 * `next: { revalidate, tags }` or `cache: "force-cache"` is cached in the data
 * cache, keyed on its URL, with that TTL and tags — so `revalidateTag(tag)` purges
 * both the data and the pages that read it. `cache: "no-store"` (or
 * `next.revalidate: 0`) is always uncached.
 */
export function installFetchCache(): void {
  if (originalFetch) return; // already installed
  originalFetch = globalThis.fetch;
  const wrapper = ((input: RequestInfo | URL, init?: FetchCacheInit): Promise<Response> => {
    const of = originalFetch!;
    if (!currentContext()) return of(input, init); // outside a request: never cache
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
      .toUpperCase();
    if (method !== "GET") return of(input, init); // only GET is cacheable
    const rev = init?.next?.revalidate;
    if (init?.cache === "no-store" || rev === 0) return of(input, init); // explicit opt-out
    const tags = init?.next?.tags ?? [];
    const wantsCache = init?.cache === "force-cache" ||
      (typeof rev === "number" && rev > 0) || tags.length > 0;
    if (!wantsCache) return of(input, init); // uncached by default
    return cachedResponse(input, init, typeof rev === "number" && rev > 0 ? rev : false, tags);
  }) as typeof fetch;
  globalThis.fetch = wrapper;
}

/**
 * Test seam: override the base fetch the cache wraps (bypasses install-once) and
 * return the previous base so it can be restored. Not part of the public API.
 *
 * @param fn The fetch implementation the cache should delegate to.
 * @returns The previous base fetch.
 */
export function __setFetchBaseForTests(fn: typeof fetch): typeof fetch {
  const prev = (originalFetch ?? globalThis.fetch) as typeof fetch;
  originalFetch = fn;
  return prev;
}

/**
 * Invalidate every cached data entry and page carrying `tag`. With the in-memory
 * default the purge is applied synchronously; with an **async store (Deno KV,
 * Redis) you should `await` the returned promise** to guarantee the purge
 * completed — inside a request it is also drained via the request's deferred
 * queue, but outside one an un-awaited call may not finish.
 *
 * @param tag The tag to purge.
 */
export function revalidateTag(tag: string): Promise<void> {
  return invalidate("tag", tag);
}

/**
 * Invalidate the cached render(s) of `path` (an exact pathname). As with
 * {@link revalidateTag}, `await` the returned promise when using an async store.
 *
 * @param path The exact pathname to purge.
 */
export function revalidatePath(path: string): Promise<void> {
  return invalidate("path", path);
}

// ---- Page cache (ISR) ------------------------------------------------------

/** A cached rendered page. */
export interface CachedPage {
  /** The full HTML document. */
  body: string;
  /** HTTP status. */
  status: number;
  /** The pathname this entry was rendered for (for `revalidatePath`). */
  path: string;
  /** Epoch ms when the store must drop the entry (hard expiry), or Infinity. */
  expiresAt: number;
  /**
   * Epoch ms when the entry goes **stale** (still served, but triggers a
   * background regeneration), or Infinity for never. Absent ⇒ never stale.
   * Enables stale-while-revalidate ISR.
   */
  staleAt?: number;
  /** Tags associated with this page (inherited from the data it read). */
  tags: string[];
  /**
   * The `Content-Security-Policy` computed for this document (hash-based, so it
   * stays valid for the byte-identical cached body). Served as-is on a cache hit.
   */
  csp?: string;
}

/**
 * The rendered-page store for Incremental Static Regeneration. A thin façade
 * over the active {@link CacheStore}: the prod server consults it before
 * rendering and populates it afterward for cacheable routes. Injecting a shared
 * store via {@linkcode setCacheStore} makes ISR work across replicas
 * transparently — this class needs no per-instance state.
 */
export class PageCache {
  /**
   * Return a fresh cached page for `key`, or undefined if missing/stale. A
   * store error is logged and treated as a miss, so a cache outage degrades to
   * live rendering rather than failing the request.
   */
  async get(key: string): Promise<CachedPage | undefined> {
    try {
      return await currentCacheStore.getPage(key);
    } catch (err) {
      logCacheError("getPage", err);
      return undefined;
    }
  }

  /** Store `page` under `key`. A store error is logged and swallowed (the page
   * is served uncached) so a failed write never fails a successful render. */
  async set(key: string, page: CachedPage): Promise<void> {
    try {
      await currentCacheStore.setPage(key, page);
    } catch (err) {
      logCacheError("setPage", err);
    }
  }

  /** Drop every entry rendered for `path`. */
  revalidatePath(path: string): Promise<void> {
    return invalidate("path", path);
  }

  /** Drop every entry carrying `tag`. */
  revalidateTag(tag: string): Promise<void> {
    return invalidate("tag", tag);
  }
}

/**
 * Decide whether a rendered page may be cached, and for how long, from its
 * segment config. Returns the expiry epoch (ms), or null when the page must be
 * rendered per request. The default (`dynamic: "auto"`, `revalidate: false`) is
 * **not** cached, so pages reading `cookies()`/`headers()` stay dynamic unless
 * they opt in.
 *
 * @param config The page's effective {@link SegmentConfig}.
 * @returns The expiry timestamp, or null if not cacheable.
 */
export function pageCacheExpiry(config: SegmentConfig): number | null {
  if (config.dynamic === "force-dynamic") return null;
  if (config.dynamic === "force-static") return Infinity;
  if (typeof config.revalidate === "number" && config.revalidate > 0) {
    return now() + config.revalidate * 1000;
  }
  return null;
}

/**
 * Cacheability + stale-while-revalidate timing for a rendered page. Returns the
 * hard `expiresAt` (when the store must drop the entry) and `staleAt` (when it
 * should be regenerated in the background while still being served), or null when
 * the page must be rendered per request.
 *
 * For a numeric `revalidate: N`, the page is served fresh for N seconds, then
 * served **stale while it regenerates** (no hard expiry) — matching Next.js ISR,
 * a strict improvement over a blocking TTL miss. `force-static` never goes stale.
 *
 * @param config The page's effective {@link SegmentConfig}.
 * @returns `{ expiresAt, staleAt }`, or null if not cacheable.
 */
export function pageCacheTiming(
  config: SegmentConfig,
): { expiresAt: number; staleAt: number } | null {
  if (config.dynamic === "force-dynamic") return null;
  if (config.dynamic === "force-static") return { expiresAt: Infinity, staleAt: Infinity };
  if (typeof config.revalidate === "number" && config.revalidate > 0) {
    return { expiresAt: Infinity, staleAt: now() + config.revalidate * 1000 };
  }
  return null;
}

// ---- helpers ---------------------------------------------------------------

function ttlToExpiry(revalidate: number | false | undefined): number {
  if (revalidate === undefined || revalidate === false) return Infinity;
  return now() + revalidate * 1000;
}

/** Stable string key for arguments; falls back to String() on non-JSON values. */
export function safeKey(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
