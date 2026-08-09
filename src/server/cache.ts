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

  // Return a fresh entry (touching it for LRU) or undefined, evicting on stale.
  function fresh<T extends { expiresAt: number }>(
    map: Map<string, T>,
    key: string,
  ): T | undefined {
    const e = map.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key); // re-insert to mark most-recently-used
    map.set(key, e);
    return e;
  }

  return {
    getData: (key) => fresh(data, key),
    setData: (key, entry) => {
      data.set(key, entry);
      evictLru(data, DATA_CACHE_MAX);
    },
    getPage: (key) => fresh(pages, key),
    setPage: (key, page) => {
      pages.set(key, page);
      evictLru(pages, PAGE_CACHE_MAX);
    },
    deleteByTag: (tag) => {
      for (const [k, e] of data) if (e.tags.includes(tag)) data.delete(k);
      for (const [k, e] of pages) if (e.tags.includes(tag)) pages.delete(k);
    },
    deleteByPath: (path) => {
      for (const [k, e] of pages) if (e.path === path) pages.delete(k);
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

/**
 * Fetch `input` and cache the response body across requests (a small
 * `fetch`-with-caching helper). Returns the cached text on a hit.
 *
 * @param input The URL or Request to fetch.
 * @param options TTL and tags for the cached body.
 */
export const cachedFetch: (
  input: string | URL,
  options?: CacheOptions & RequestInit,
) => Promise<string> = unstable_cache(
  async (input: string | URL, options?: RequestInit) => {
    const res = await fetch(input, options);
    return await res.text();
  },
  ["denext:cachedFetch"],
);

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
  /** Epoch ms when the entry goes stale, or Infinity. */
  expiresAt: number;
  /** Tags associated with this page (inherited from the data it read). */
  tags: string[];
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
