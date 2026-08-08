// Data cache, request memoization, and Incremental Static Regeneration (ISR).
//
//   cache(fn)            — memoize fn for the duration of a single request
//   unstable_cache(fn)   — cross-request cache with TTL + tags
//   revalidateTag(tag)   — purge cached data/pages carrying that tag
//   revalidatePath(path) — purge the cached render of a path
//   PageCache            — the prod server's rendered-page ISR store
//
// Time is read via Date.now(); all stores are in-memory and process-local
// (denext runs one app per process).

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

// ---- Cross-request data cache ---------------------------------------------

interface DataEntry {
  value: unknown;
  /** Epoch ms when the entry goes stale, or Infinity for no expiry. */
  expiresAt: number;
  tags: string[];
}

const dataCache = new Map<string, DataEntry>();

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
 * the call arguments.
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
    const hit = dataCache.get(key);
    if (hit && (hit.expiresAt === Infinity || hit.expiresAt > now())) {
      return hit.value as R;
    }
    const value = await fn(...args);
    const expiresAt = ttlToExpiry(options.revalidate);
    dataCache.set(key, { value, expiresAt, tags: options.tags ?? [] });
    return value;
  };
}

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

/** Invalidate every cached data entry and page carrying `tag`. */
export function revalidateTag(tag: string): void {
  for (const [k, e] of dataCache) {
    if (e.tags.includes(tag)) dataCache.delete(k);
  }
  for (const pc of pageCaches) pc.revalidateTag(tag);
}

/** Invalidate the cached render(s) of `path` (an exact pathname). */
export function revalidatePath(path: string): void {
  for (const pc of pageCaches) pc.revalidatePath(path);
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
  /** Tags associated with this page. */
  tags: string[];
}

/** Registry of live page caches so `revalidatePath`/`revalidateTag` can reach them. */
const pageCaches = new Set<PageCache>();

/**
 * An in-memory store of rendered pages for Incremental Static Regeneration.
 * The prod server consults it before rendering and populates it afterward for
 * cacheable routes; `revalidatePath`/`revalidateTag` purge entries.
 */
export class PageCache {
  private store = new Map<string, CachedPage>();

  /** Register this cache for tag/path invalidation. */
  constructor() {
    pageCaches.add(this);
  }

  /** Return a fresh cached page for `key`, or undefined if missing/stale. */
  get(key: string): CachedPage | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  /** Store `page` under `key`. */
  set(key: string, page: CachedPage): void {
    this.store.set(key, page);
  }

  /** Drop every entry rendered for `path`. */
  revalidatePath(path: string): void {
    for (const [k, e] of this.store) {
      if (e.path === path) this.store.delete(k);
    }
  }

  /** Drop every entry carrying `tag`. */
  revalidateTag(tag: string): void {
    for (const [k, e] of this.store) {
      if (e.tags.includes(tag)) this.store.delete(k);
    }
  }

  /** Number of entries currently cached (for tests/introspection). */
  get size(): number {
    return this.store.size;
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
function safeKey(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
