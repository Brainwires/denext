// Data cache, request memoization, and Incremental Static Regeneration (ISR).
//
//   cache(fn)            — memoize fn for the duration of a single request
//   unstable_cache(fn)   — cross-request cache with TTL + tags
//   revalidateTag(tag)   — purge cached data/pages carrying that tag
//   revalidatePath(path) — purge the cached render of a path
//   PageCache            — the prod server's rendered-page ISR store
//
// The default durable store is Deno's built-in node:sqlite (a local
// SQLite file), resolved automatically at startup by {@linkcode resolveDefaultCacheStore}
// with a graceful in-memory fallback. Override it — a custom or shared store (Redis,
// etc.) — with {@linkcode setCacheStore}, so ISR renders and cached data are shared
// across replicas and `revalidateTag`/`revalidatePath` reach every instance. Time is
// read via Date.now(); a shared store assumes a shared wall clock.

import { AsyncLocalStorage } from "node:async_hooks";
import { currentContext } from "./request-context.ts";
import { withoutPostpone } from "../runtime/prerender.ts";
import type { CspSetting, SegmentConfig } from "./segment-config.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { IslandPayload } from "../jsx/render-to-html-flight.ts";
import type { CacheConfig } from "./config.ts";

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
  /** Epoch ms when the entry hard-expires (a miss), or Infinity for no expiry. */
  expiresAt: number;
  /**
   * Epoch ms when the entry goes **stale** — still served, but triggers a
   * background refresh (stale-while-revalidate). Absent ⇒ never stale. Set by a
   * soft `revalidateTag(tag, profile)`.
   */
  staleAt?: number;
  /** Tags for targeted invalidation via {@link revalidateTag}. */
  tags: string[];
}

/** New timing for a soft (SWR) invalidation: stale immediately, hard-expire later. */
export interface CacheEntryTiming {
  /** Epoch ms at which entries become stale (typically now). */
  staleAt: number;
  /** Epoch ms hard-expiry, or Infinity to keep serving stale indefinitely. */
  expiresAt: number;
}

/**
 * The pluggable backend behind denext's data cache and page (ISR) cache.
 *
 * The default is the durable `node:sqlite` store (resolved by
 * {@linkcode resolveDefaultCacheStore}, with an in-memory fallback). Inject a store
 * backed by a shared cache (Redis, etc.) with {@linkcode setCacheStore} so cached data
 * and rendered pages are shared across replicas and invalidation reaches every instance.
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
  /**
   * Optional: **soft-expire** every entry carrying `tag` — rewrite its
   * `staleAt`/`expiresAt` (stale-while-revalidate) instead of deleting it, so a
   * `revalidateTag(tag, profile)` serves stale while refreshing. A store that omits
   * this falls back to a hard {@link deleteByTag} (correct, just not SWR).
   */
  expireByTag?(tag: string, timing: CacheEntryTiming): void | Promise<void>;
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
// The same reasoning for the data cache: a cached fetch body or unstable_cache
// value can be large, so the 1000-entry count alone is not a memory bound. Evict
// the LRU until BOTH the count and byte budgets hold (~32 MB default).
const DATA_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// Proactively drop hard-expired entries at most this often, so a workload of
// short-TTL keys that are written once and never re-read doesn't retain them
// (getData/getPage evict on access, but only for keys that are read again).
const SWEEP_INTERVAL = 30_000;

/** Approximate retained bytes of a cached page (the body dominates). */
function pageBytes(p: CachedPage): number {
  return p.body.length + (p.csp ? p.csp.length : 0);
}

/**
 * Approximate retained bytes of a cached data entry. The value dominates; measure
 * it via its JSON length (a cheap, monotonic proxy). A non-serializable value
 * (BigInt, circular ref) can't be sized this way — fall back to a nominal 1 KiB so
 * such entries still count toward, and can be evicted by, the byte budget.
 */
function dataBytes(e: DataEntry): number {
  try {
    const json = JSON.stringify(e.value);
    return json === undefined ? 1024 : json.length;
  } catch {
    return 1024;
  }
}

/** The default per-process, in-memory {@link CacheStore}. */
export function inMemoryCacheStore(): CacheStore {
  const data = new Map<string, DataEntry>();
  const pages = new Map<string, CachedPage>();
  let pageByteTotal = 0;
  let dataByteTotal = 0;
  let lastSweep = now();

  // Delete a data entry, keeping the running byte total in sync.
  function deleteData(key: string): void {
    const e = data.get(key);
    if (e) {
      dataByteTotal -= dataBytes(e);
      data.delete(key);
    }
  }

  // Return a fresh data entry (touching it for LRU) or undefined, evicting stale.
  function freshData(key: string): DataEntry | undefined {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== Infinity && e.expiresAt <= now()) {
      deleteData(key);
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
      if (e.expiresAt !== Infinity && e.expiresAt <= t) deleteData(k);
    }
    for (const [k, e] of pages) {
      if (e.expiresAt !== Infinity && e.expiresAt <= t) deletePage(k);
    }
  }

  return {
    getData: (key) => freshData(key),
    setData: (key, entry) => {
      const prev = data.get(key);
      if (prev) dataByteTotal -= dataBytes(prev);
      data.set(key, entry);
      dataByteTotal += dataBytes(entry);
      // Evict oldest until within both the count and byte budgets. Never evict the
      // sole remaining entry (a single oversize value is still served).
      while (
        (data.size > DATA_CACHE_MAX || dataByteTotal > DATA_CACHE_MAX_BYTES) &&
        data.size > 1
      ) {
        const oldest = data.keys().next().value;
        if (oldest === undefined) break;
        deleteData(oldest);
      }
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
      for (const [k, e] of data) if (e.tags.includes(tag)) deleteData(k);
      for (const [k, e] of pages) if (e.tags.includes(tag)) deletePage(k);
    },
    deleteByPath: (path) => {
      for (const [k, e] of pages) if (e.path === path) deletePage(k);
    },
    // Soft-expire: mark matching entries stale (still served) and reset hard expiry,
    // in place. Byte totals are unchanged since the value is untouched.
    expireByTag: (tag, timing) => {
      for (const [, e] of data) {
        if (e.tags.includes(tag)) {
          e.staleAt = timing.staleAt;
          e.expiresAt = timing.expiresAt;
        }
      }
      for (const [, e] of pages) {
        if (e.tags.includes(tag)) {
          e.staleAt = timing.staleAt;
          e.expiresAt = timing.expiresAt;
        }
      }
    },
  };
}

let currentCacheStore: CacheStore = inMemoryCacheStore();

// Whether the app (or resolveDefaultCacheStore) has replaced the initial in-memory
// store. resolveDefaultCacheStore is a no-op once a store has been set explicitly, so a
// user's own setCacheStore(...) in denext.config.ts / the server entry always wins over
// the smart default.
let storeExplicitlySet = false;

/**
 * Replace the {@link CacheStore} backing the data cache and page (ISR) cache.
 * Use this to share cached data and rendered pages across instances — back it
 * with a custom or shared store (Redis, etc.) so a render or data entry produced on one
 * replica is served by another, and `revalidateTag`/`revalidatePath` invalidate every
 * instance. Called explicitly, this overrides the smart default
 * ({@linkcode resolveDefaultCacheStore}).
 *
 * @param store The store to use for all subsequent cache operations.
 */
export function setCacheStore(store: CacheStore): void {
  currentCacheStore = store;
  storeExplicitlySet = true;
}

/** The {@link CacheStore} currently backing the data + page cache. */
export function getCacheStore(): CacheStore {
  return currentCacheStore;
}

/**
 * Resolve and install the default cache store at startup, unless the app already called
 * {@linkcode setCacheStore}. Prefers the durable `node:sqlite` file store; falls back to
 * the in-memory store when it can't initialize (denied `--allow-write`, an
 * ephemeral/read-only host) — never a hard failure.
 *
 * Resolution order:
 * 1. A store already set explicitly → leave it.
 * 2. `config.store` — `"memory"`, `"sqlite"`, or a {@link CacheStore} object → use it.
 * 3. On Deno Deploy (`DENO_DEPLOYMENT_ID`) → in-memory (no persistent local FS).
 * 4. Otherwise probe `node:sqlite`; success → SQLite, failure → in-memory.
 *
 * @param config The resolved `cache` config (from `denext.config.ts`), if any.
 */
export async function resolveDefaultCacheStore(
  config?: CacheConfig,
): Promise<void> {
  if (storeExplicitlySet) return;
  setCacheStore(await chooseCacheStore(config));
}

/**
 * Pure resolution of the default {@link CacheStore} for a `cache` config (no side effects
 * — the caller installs the result). Order: explicit object/`"memory"` → in-memory on
 * Deno Deploy (unless `"sqlite"` forced) → probe `node:sqlite`, falling back to
 * in-memory if it can't initialize. Exposed for tests; apps use
 * {@link resolveDefaultCacheStore}.
 */
export async function chooseCacheStore(
  config?: CacheConfig,
): Promise<CacheStore> {
  if (config?.store && typeof config.store === "object") return config.store;
  if (config?.store === "memory") return inMemoryCacheStore();

  const wantSqlite = config?.store === "sqlite";

  // Serverless (Deno Deploy) has no persistent local FS, so a file-backed store would be
  // ephemeral anyway — use in-memory unless SQLite was explicitly requested.
  let onDeploy = false;
  try {
    onDeploy = !!Deno.env.get("DENO_DEPLOYMENT_ID");
  } catch {
    // --allow-env not granted; treat as not-on-Deploy.
  }
  if (onDeploy && !wantSqlite) return inMemoryCacheStore();

  // Probe the durable node:sqlite store. A tiny read forces the file open, so a denied
  // --allow-write or an ephemeral/read-only FS surfaces here.
  try {
    const { sqliteCacheStore } = await import("./sqlite-cache.ts");
    const store = sqliteCacheStore({
      path: config?.path,
      maxDataEntries: config?.maxDataEntries,
      maxPageEntries: config?.maxPageEntries,
    });
    await store.getData("__denext_probe__");
    return store;
  } catch (err) {
    // Fall back to in-memory. Loud in dev so the reason (denied write, ephemeral FS) is
    // visible; silent in prod (the cache still works).
    if ((globalThis as { __denextDev?: boolean }).__denextDev) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `denext: durable node:sqlite cache unavailable — using the in-memory store. (${reason})`,
      );
    }
    return inMemoryCacheStore();
  }
}

// Live Server Components subscribe to tag invalidations here: whenever a tag is
// purged or soft-expired, the live hub re-renders and pushes the affected
// boundaries to connected clients. A seam (like `setCacheStore`) so the cache
// core never imports the live/transport layer, and it stays absent from apps
// that don't use `<Live>`. Fire-and-forget and guarded — a hook error must never
// disturb an invalidation.
let liveInvalidateHook: ((tags: readonly string[]) => void) | null = null;

/**
 * Register a hook invoked with the tag(s) whenever {@link revalidateTag} /
 * {@link updateTag} (or a soft-expire) invalidates them. Used by Live Server
 * Components to push updates to connected clients. Passing `null` unregisters it.
 *
 * @param hook Receives the invalidated tags, or `null` to clear.
 */
export function setLiveInvalidateHook(hook: ((tags: readonly string[]) => void) | null): void {
  liveInvalidateHook = hook;
}

/** Notify the live hook of invalidated tags, swallowing any hook error. */
function notifyLive(tags: readonly string[]): void {
  const hook = liveInvalidateHook;
  if (!hook || tags.length === 0) return;
  try {
    hook(tags);
  } catch (err) {
    logCacheError("liveInvalidateHook", err);
  }
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

// ---- cacheLife profiles + cache scope (Cache Components) --------------------

/**
 * A cache lifetime profile, in **seconds** (Next.js `cacheLife`). All fields are
 * optional; an omitted field inherits the `default` profile's value.
 */
export interface CacheLifeProfile {
  /** Client-side staleness window: served without a background check (SWR hint). */
  stale?: number;
  /** Seconds until the entry is refreshed in the background (stale-while-revalidate). */
  revalidate?: number;
  /** Hard maximum age (seconds) before the value must be recomputed; `Infinity` = never. */
  expire?: number;
}

/** Built-in cacheLife profiles (seconds), matching Next.js's defaults. */
const BUILTIN_CACHE_LIFE: Record<string, CacheLifeProfile> = {
  default: { stale: 300, revalidate: 900, expire: Infinity },
  seconds: { stale: 0, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: Infinity },
};

/** Custom profiles registered from config, overlaid on (and overriding) the built-ins. */
const customCacheLife = new Map<string, CacheLifeProfile>();

/**
 * Register named cacheLife profiles (typically from `denext.config`). A custom
 * profile whose name collides with a built-in overrides it. Idempotent-ish: a later
 * call with the same name wins.
 *
 * @param profiles A map of profile name to `{ stale, revalidate, expire }` seconds.
 */
export function registerCacheLifeProfiles(profiles: Record<string, CacheLifeProfile>): void {
  for (const [name, p] of Object.entries(profiles)) customCacheLife.set(name, p);
}

/**
 * Resolve a cacheLife argument — a built-in/custom profile name or an inline
 * profile object — to a concrete {@link CacheLifeProfile}. An unknown name falls
 * back to the `default` profile. Missing fields inherit from `default`.
 *
 * @param profile A profile name or an inline `{ stale, revalidate, expire }`.
 * @returns The resolved profile with every field populated.
 */
export function resolveCacheLife(profile: string | CacheLifeProfile): CacheLifeProfile {
  const base = BUILTIN_CACHE_LIFE.default;
  const raw = typeof profile === "string"
    ? (customCacheLife.get(profile) ?? BUILTIN_CACHE_LIFE[profile] ?? base)
    : profile;
  return {
    stale: raw.stale ?? base.stale,
    revalidate: raw.revalidate ?? base.revalidate,
    expire: raw.expire ?? base.expire,
  };
}

/** Mutable state a `use cache` scope accrues via {@link cacheLife} / {@link cacheTag}. */
export interface CacheScope {
  /** The lifetime chosen for this entry (last `cacheLife` wins); undefined ⇒ default. */
  life?: CacheLifeProfile;
  /** Tags attached to this entry via `cacheTag`. */
  tags: string[];
}

// A `use cache` function body runs inside one of these; AsyncLocalStorage (not a
// module stack) so concurrent cached renders that interleave across `await` each
// see their own scope.
const cacheScopeStorage = new AsyncLocalStorage<CacheScope>();

/** The cache scope of the enclosing `use cache` function, or undefined outside one. */
export function currentCacheScope(): CacheScope | undefined {
  return cacheScopeStorage.getStore();
}

/**
 * Run `fn` inside a fresh cache scope and return both its value and the scope it
 * accrued (the chosen `cacheLife` + `cacheTag`s). The `use cache` executor uses
 * this to learn an entry's lifetime/tags after running its body.
 */
export function withCacheScope<T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; scope: CacheScope }> {
  const scope: CacheScope = { tags: [] };
  // A `use cache` body is static: reads inside it must not postpone during a PPR
  // prerender (the cached value stands in for the request-independent result).
  return withoutPostpone(() => Promise.resolve(cacheScopeStorage.run(scope, fn)))
    .then((value) => ({ value, scope }));
}

/**
 * Set the cache lifetime of the enclosing `use cache` function (Next.js `cacheLife`).
 * A no-op when called outside a cached scope. The last call wins.
 *
 * @param profile A built-in/custom profile name, or an inline `{ stale, revalidate, expire }`.
 */
export function cacheLife(profile: string | CacheLifeProfile): void {
  const scope = cacheScopeStorage.getStore();
  if (scope) scope.life = resolveCacheLife(profile);
}

/**
 * Tag the enclosing `use cache` entry (Next.js `cacheTag`) so `revalidateTag` /
 * `updateTag` can purge it, and propagate the tags to the enclosing page render so
 * `revalidateTag` purges the page too. Safe to call outside a cache scope (then it
 * only does the page propagation).
 *
 * @param tags One or more tags to attach.
 */
export function cacheTag(...tags: string[]): void {
  if (tags.length === 0) return;
  const scope = cacheScopeStorage.getStore();
  if (scope) scope.tags.push(...tags);
  collectTags(tags);
}

// The cache is best-effort: a backing-store error (e.g. a disk/IO failure, or a
// shared-store outage) must never fail a request — reads fall through to a live
// render and writes are skipped. Errors are logged, throttled so a sustained
// outage cannot flood stdout.
// Rate-limit PER operation, not globally: a sustained getData outage must not
// suppress the first log of an unrelated setPage failure (a single global gate
// would hide whole classes of error behind whichever one logs first each second).
const lastCacheErrorLog = new Map<string, number>();
function logCacheError(op: string, err: unknown): void {
  const t = now();
  if (t - (lastCacheErrorLog.get(op) ?? 0) < 1000) return; // ≤ 1 line/sec per op
  lastCacheErrorLog.set(op, t);
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
// ---- Cache observability (glass-box) --------------------------------------

/** One cache invalidation (a `revalidateTag`/`revalidatePath`), with timing. */
export interface InvalidationEvent {
  kind: "tag" | "path";
  value: string;
  /** Epoch ms when it happened. */
  at: number;
}

/** A snapshot of cache activity (see {@link getCacheStats}). */
export interface CacheStats {
  pageHits: number;
  pageMisses: number;
  pageSets: number;
  invalidations: number;
  /** The most recent invalidations (newest last) — revalidation-timing visibility. */
  recentInvalidations: InvalidationEvent[];
}

const RECENT_INVALIDATIONS_MAX = 50;
const cacheStats: CacheStats = {
  pageHits: 0,
  pageMisses: 0,
  pageSets: 0,
  invalidations: 0,
  recentInvalidations: [],
};

/**
 * A snapshot of cache activity: page (ISR) cache hit/miss/set counts and the recent
 * `revalidateTag`/`revalidatePath` invalidations (with timing). The observable layer a
 * cache glass-box / devtools reads — and usable for production monitoring.
 */
export function getCacheStats(): CacheStats {
  return { ...cacheStats, recentInvalidations: [...cacheStats.recentInvalidations] };
}

/** Reset the cache-activity counters (tests / a fresh monitoring window). */
export function resetCacheStats(): void {
  cacheStats.pageHits = 0;
  cacheStats.pageMisses = 0;
  cacheStats.pageSets = 0;
  cacheStats.invalidations = 0;
  cacheStats.recentInvalidations = [];
}

function recordInvalidation(kind: "tag" | "path", value: string): void {
  cacheStats.invalidations++;
  cacheStats.recentInvalidations.push({ kind, value, at: now() });
  if (cacheStats.recentInvalidations.length > RECENT_INVALIDATIONS_MAX) {
    cacheStats.recentInvalidations.shift();
  }
}

function invalidate(kind: "tag" | "path", value: string): Promise<void> {
  recordInvalidation(kind, value);
  const raw = kind === "tag"
    ? currentCacheStore.deleteByTag(value)
    : currentCacheStore.deleteByPath(value);
  const p = Promise.resolve(raw).catch((err) =>
    logCacheError(kind === "tag" ? "deleteByTag" : "deleteByPath", err)
  );
  const ctx = currentContext();
  if (ctx) ctx.deferred.push(() => p);
  if (kind === "tag") notifyLive([value]); // wake any <Live> boundary on this tag
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
    // Read-your-writes: a Server Action's updateTag(tag) earlier this request forces
    // a miss so the acting user sees their own write, even before the async store
    // purge is visible.
    if (hit && tagUpdatedThisRequest(hit.tags)) hit = undefined;
    if (hit) {
      // Stale-while-revalidate: a soft `revalidateTag(tag, profile)` marked this
      // entry stale — serve it now and refresh in the background (deduped per key)
      // so the next reader gets fresh data.
      if (hit.staleAt != null && hit.staleAt <= now()) {
        reviveStaleData(key, () => fn(...args), options.revalidate, tags);
      }
      return hit.value as R;
    }
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

/** Keys currently being refreshed in the background (SWR), so we refresh once. */
const dataRevalidateInFlight = new Set<string>();

/**
 * Refresh a stale data-cache entry in the background: run `compute` once (deduped
 * per key), store the fresh value, and — inside a request — register the promise on
 * the deferred queue so a serverless isolate drains it before freezing. Errors are
 * logged; the stale value has already been served.
 */
function reviveStaleData(
  key: string,
  compute: () => Promise<unknown> | unknown,
  revalidate: number | false | undefined,
  tags: string[],
): void {
  if (dataRevalidateInFlight.has(key)) return;
  dataRevalidateInFlight.add(key);
  const p = (async () => {
    try {
      const value = await compute();
      await currentCacheStore.setData(key, { value, expiresAt: ttlToExpiry(revalidate), tags });
    } catch (err) {
      logCacheError("revalidate", err);
    } finally {
      dataRevalidateInFlight.delete(key);
    }
  })();
  const ctx = currentContext();
  if (ctx) ctx.deferred.push(() => p);
}

// ---- `"use cache"` directive runtime executor -----------------------------

/** Dedupe tags while preserving first-seen order (cheap; small arrays). */
function dedupeTags(tags: string[]): string[] {
  return tags.length > 1 ? [...new Set(tags)] : tags;
}

/**
 * Turn a resolved {@link CacheLifeProfile} into concrete entry timing measured
 * from `now()`: the hard `expiresAt` (from `expire`) and the SWR `staleAt` (from
 * `revalidate`). `Infinity`/absent fields mean "never".
 */
function lifeTiming(life: CacheLifeProfile): { expiresAt: number; staleAt?: number } {
  const { expire, revalidate } = life;
  return {
    expiresAt: expire == null || expire === Infinity ? Infinity : now() + expire * 1000,
    staleAt: revalidate == null || revalidate === Infinity ? undefined : now() + revalidate * 1000,
  };
}

/**
 * Run a `use cache` body inside a fresh cache scope and build the {@link DataEntry}
 * to store: the value plus the timing/tags the body declared via `cacheLife`/
 * `cacheTag` (falling back to `fallback` — the transform-supplied profile — then the
 * built-in `default` profile). The scope's tags also propagate to the enclosing page.
 */
async function runCachedBody<R>(
  run: () => R | Promise<R>,
  staticTags: string[],
  fallback?: string | CacheLifeProfile,
): Promise<{ entry: DataEntry; value: R }> {
  const { value, scope } = await withCacheScope(run);
  const life = scope.life ?? resolveCacheLife(fallback ?? "default");
  const { expiresAt, staleAt } = lifeTiming(life);
  const tags = dedupeTags([...staticTags, ...scope.tags]);
  return { value, entry: { value, expiresAt, staleAt, tags } };
}

/**
 * Refresh a stale `use cache` entry in the background (deduped per key), re-running
 * the body inside its cache scope so the recomputed value picks up fresh
 * `cacheLife`/`cacheTag` timing. Inside a request the promise is registered on the
 * deferred queue so a serverless isolate drains it before freezing.
 */
function reviveStaleUseCache(
  key: string,
  run: () => unknown | Promise<unknown>,
  staticTags: string[],
  profile: string | CacheLifeProfile | undefined,
): void {
  if (dataRevalidateInFlight.has(key)) return;
  dataRevalidateInFlight.add(key);
  const p = (async () => {
    try {
      const { entry } = await runCachedBody(run, staticTags, profile);
      await currentCacheStore.setData(key, entry);
    } catch (err) {
      logCacheError("revalidate", err);
    } finally {
      dataRevalidateInFlight.delete(key);
    }
  })();
  const ctx = currentContext();
  if (ctx) ctx.deferred.push(() => p);
}

/**
 * Runtime executor for the `"use cache"` directive (Cache Components). The
 * build-time transform (`src/build/use-cache-transform.ts`) rewrites each cached
 * function `fn` into `__useCache("<moduleId>#<name>", fn, { profile, tags })`; the
 * returned wrapper caches `fn`'s result across requests keyed on `id` + arguments,
 * with single-flight de-duplication, stale-while-revalidate, and read-your-writes
 * (`updateTag`) — the same machinery as {@link unstable_cache}, but the lifetime and
 * tags come from `cacheLife`/`cacheTag` calls **inside** the body (captured via the
 * cache scope) rather than from static options.
 *
 * Not a public API — only generated code calls it.
 *
 * @param id A stable key prefix (module id + function name).
 * @param fn The original (directive-bearing) function.
 * @param options Optional transform-supplied fallback `profile` and static `tags`.
 * @returns A wrapper with `fn`'s signature, always returning a Promise.
 */
export function __useCache<A extends unknown[], R>(
  id: string,
  fn: (...args: A) => R | Promise<R>,
  options: { profile?: string | CacheLifeProfile; tags?: string[] } = {},
): (...args: A) => Promise<R> {
  const staticTags = options.tags ?? [];
  return async (...args: A): Promise<R> => {
    const key = safeKey([id, args]);
    collectTags(staticTags);
    let hit: DataEntry | undefined;
    try {
      hit = await currentCacheStore.getData(key);
    } catch (err) {
      logCacheError("getData", err); // treat a store error as a miss
    }
    // Read-your-writes: a same-request updateTag(tag) forces a miss so the writer
    // sees fresh data (mirrors unstable_cache).
    if (hit && tagUpdatedThisRequest(hit.tags)) hit = undefined;
    if (hit) {
      // The body didn't run on a hit, so replay its tag propagation to the page
      // from the stored tags.
      collectTags(hit.tags);
      if (hit.staleAt != null && hit.staleAt <= now()) {
        reviveStaleUseCache(key, () => fn(...args), staticTags, options.profile);
      }
      return hit.value as R;
    }
    // Single-flight: coalesce concurrent misses so the body runs once.
    const inFlight = dataInFlight.get(key) as Promise<DataEntry> | undefined;
    if (inFlight) {
      // A follower didn't run the body, so it never saw the body-declared
      // `cacheTag()`s. Replay them onto THIS request's page (mirroring the hit
      // path) so `revalidateTag` invalidates the follower's page too — otherwise
      // the coalesced page under-invalidates and serves stale content forever.
      const entry = await inFlight;
      collectTags(entry.tags);
      return entry.value as R;
    }
    const compute: Promise<DataEntry> = (async () => {
      const { entry } = await runCachedBody(() => fn(...args), staticTags, options.profile);
      try {
        await currentCacheStore.setData(key, entry);
      } catch (err) {
        logCacheError("setData", err); // couldn't cache; still return the value
      }
      return entry;
    })();
    dataInFlight.set(key, compute);
    try {
      // The leader collected the body's tags during `runCachedBody` (in its own
      // request scope), so it returns the value directly.
      return (await compute).value as R;
    } finally {
      dataInFlight.delete(key); // clear on both fulfil and reject
    }
  };
}

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
  // Fold the request headers into the key too: a `Headers` instance serializes to
  // "{}" (and a plain-object header list keys by casing/order), so two requests to
  // the same URL differing only by e.g. `Authorization` would otherwise collide
  // onto one entry — cross-user response-body confusion (cf. CVE-2026-64648).
  // Replacing headers with the normalized fingerprint makes the key reflect them
  // and still passes a valid HeadersInit to fetch.
  if (options?.headers) {
    options = { ...options, headers: headerFingerprint(options.headers) };
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
  // Key on the headers actually sent, not just the URL: two GETs to the same URL
  // with different `Authorization`/`Accept-Language` must not share one cached
  // body (cross-user confusion, cf. CVE-2026-64648). Per fetch semantics an
  // explicit `init.headers` replaces a Request's headers, so fingerprint whichever
  // will be sent.
  const effectiveHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const key = safeKey(["denext:fetch", url, tags, headerFingerprint(effectiveHeaders)]);
  const store = currentCacheStore;
  const read = async (): Promise<Response | undefined> => {
    try {
      const hit = await store.getData(key);
      // Read-your-writes: skip a hit whose tag was updateTag'd earlier this request.
      if (hit && !tagUpdatedThisRequest(hit.tags)) return responseFrom(hit.value as CachedResponse);
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
 *
 * A route's `export const fetchCache` segment default shifts this baseline for
 * fetches made while rendering it (per-call `cache`/`next` still take precedence,
 * except where a `force-*` segment overrides them):
 * - `"force-no-store"` / `"only-no-store"` — never cache (overrides per-call opt-in).
 * - `"force-cache"` / `"only-cache"` — cache every GET (overrides per-call no-store).
 * - `"default-cache"` — cache GETs by default unless the call sets `no-store`.
 * - `"default-no-store"` / `"auto"` / unset — the secure default above (opt-in only).
 */
export function installFetchCache(): void {
  if (originalFetch) return; // already installed
  originalFetch = globalThis.fetch;
  const wrapper = ((input: RequestInfo | URL, init?: FetchCacheInit): Promise<Response> => {
    const of = originalFetch!;
    const ctx = currentContext();
    if (!ctx) return of(input, init); // outside a request: never cache
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
      .toUpperCase();
    if (method !== "GET") return of(input, init); // only GET is cacheable

    // Route `fetchCache` segment default shifts the baseline (per-call still wins,
    // except a force-* segment overrides it).
    const fc = ctx.segmentConfig?.fetchCache;
    const forceNoStore = fc === "force-no-store" || fc === "only-no-store";
    const forceCache = fc === "force-cache" || fc === "only-cache";
    const defaultCache = fc === "default-cache";
    if (forceNoStore) return of(input, init); // segment forbids caching outright

    const rev = init?.next?.revalidate;
    const explicitNoStore = init?.cache === "no-store" || rev === 0;
    if (explicitNoStore && !forceCache) return of(input, init); // honored unless forced

    const tags = init?.next?.tags ?? [];
    const perCallOptIn = init?.cache === "force-cache" ||
      (typeof rev === "number" && rev > 0) || tags.length > 0;
    const wantsCache = forceCache || (defaultCache && !explicitNoStore) || perCallOptIn;
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
 * Invalidate every cached data entry and page carrying `tag`.
 *
 * - **`revalidateTag(tag)`** (single arg) hard-purges the entries — the original
 *   (Next.js-deprecated but still supported) form.
 * - **`revalidateTag(tag, profile)`** soft-expires them with stale-while-revalidate
 *   timing from the `cacheLife` `profile` (a name like `"max"`/`"hours"` or an inline
 *   `{ stale, revalidate, expire }`): entries are served **stale** while refreshed in
 *   the background, matching Next.js 16. Stores without soft-expire support
 *   ({@link CacheStore.expireByTag}) fall back to a hard purge.
 *
 * With the in-memory default the change is applied synchronously; with an **async
 * store you should `await` the returned promise**. Inside a request it is also
 * drained via the deferred queue.
 *
 * @param tag The tag to invalidate.
 * @param profile Optional `cacheLife` profile for stale-while-revalidate behavior.
 */
export function revalidateTag(tag: string, profile?: string | CacheLifeProfile): Promise<void> {
  if (profile === undefined) return invalidate("tag", tag); // hard purge
  const life = resolveCacheLife(profile);
  const expireSecs = life.expire;
  const timing: CacheEntryTiming = {
    staleAt: now(),
    expiresAt: expireSecs == null || expireSecs === Infinity ? Infinity : now() + expireSecs * 1000,
  };
  const store = currentCacheStore;
  const raw = store.expireByTag ? store.expireByTag(tag, timing) : store.deleteByTag(tag);
  const p = Promise.resolve(raw).catch((err) => logCacheError("expireByTag", err));
  const ctx = currentContext();
  if (ctx) ctx.deferred.push(() => p);
  notifyLive([tag]); // wake any <Live> boundary on this tag (soft-expire path)
  return p;
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

/**
 * **Read-your-writes** tag invalidation for use inside a Server Action (Next.js 16
 * `updateTag`). Unlike {@link revalidateTag}, it expires the tag **immediately and
 * synchronously for the rest of this request**: a later cache read in the same
 * action whose entry carries `tag` recomputes, so the acting user sees their own
 * write right away. It also hard-purges the store (for other requests/replicas) and
 * records the tag so the client router can refresh the affected content.
 *
 * Outside a request context it degrades to a plain {@link revalidateTag} purge.
 *
 * @param tag The tag to expire.
 */
export function updateTag(tag: string): Promise<void> {
  const ctx = currentContext();
  if (ctx) (ctx.updatedTags ??= new Set<string>()).add(tag);
  return invalidate("tag", tag); // hard purge for other requests/replicas
}

/**
 * Request a refresh of the **uncached** data on the current route from inside a
 * Server Action (Next.js 16 `refresh`). It doesn't touch the cache — it flags the
 * request so the action response tells the client router to re-fetch, keeping cached
 * shells/static content fast while dynamic data (notification counts, live metrics)
 * updates. A no-op outside a request context.
 */
export function refresh(): void {
  const ctx = currentContext();
  if (ctx) ctx.refreshRequested = true;
}

/** True if any of `tags` was expired via {@link updateTag} earlier this request. */
function tagUpdatedThisRequest(tags: string[]): boolean {
  if (tags.length === 0) return false;
  const updated = currentContext()?.updatedTags;
  if (!updated || updated.size === 0) return false;
  return tags.some((t) => updated.has(t));
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
   * For a PPR shell ({@link holeIds} set) the body varies per request, so `csp` is
   * absent and the policy is recomputed on each serve.
   */
  csp?: string;
  /**
   * Cache Components / PPR: when set, `body` is a static *shell* document whose
   * dynamic holes (these ids) must be re-rendered per request and spliced in
   * before serving (see `spliceShellHoles`). Absent ⇒ an ordinary fully-rendered
   * page served verbatim.
   */
  holeIds?: string[];
  /**
   * PPR only: the route's CSP opt-ins, needed to recompute the policy for each
   * per-request spliced body (the shell alone doesn't carry them).
   */
  routeCsp?: CspSetting;
  /**
   * PPR only: the static head extras the shell prerender hoisted (in-tree
   * `<meta>`/`<link>`, resource hints, font CSS). A cache hit re-runs
   * `generateMetadata` per request and re-merges these to rebuild the `<head>`, so
   * per-request metadata (from cookies/headers) is reflected without re-rendering
   * the cached shell body.
   */
  headExtras?: string;
  /** PPR only: an in-tree `<title>` from the shell (wins over `generateMetadata`). */
  inTreeTitle?: string;
  /**
   * Flight PPR only: the request-independent shell Flight tree (dynamic holes as
   * `{$:"$",r:id}` placeholders). A per-request resume fills these holes with its
   * Flight subtrees; its presence marks a Flight ("use client") PPR shell (served via
   * `streamPprFlightDocument` instead of `streamPprDocument`).
   */
  flightShell?: FlightNode;
  /** Flight PPR only: the static shell's `client:*` islands, keyed by tree-path id. */
  flightIslands?: IslandPayload[];
  /** Flight PPR only: signal state (`useId → value`) captured in the static shell. */
  flightSignalState?: Record<string, unknown>;
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
      const page = await currentCacheStore.getPage(key);
      if (page) cacheStats.pageHits++;
      else cacheStats.pageMisses++;
      return page;
    } catch (err) {
      logCacheError("getPage", err);
      cacheStats.pageMisses++;
      return undefined;
    }
  }

  /** Store `page` under `key`. A store error is logged and swallowed (the page
   * is served uncached) so a failed write never fails a successful render. */
  async set(key: string, page: CachedPage): Promise<void> {
    try {
      await currentCacheStore.setPage(key, page);
      cacheStats.pageSets++;
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

/**
 * A stable fingerprint of request headers for cache keying: normalized (lowercased
 * names) and sorted `[name, value]` pairs. Two requests that differ only by a
 * header (e.g. `Authorization`) must produce different fingerprints so they never
 * share a cached response body — otherwise one visitor's authenticated response
 * could be served to another (cf. CVE-2026-64648).
 */
function headerFingerprint(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  // `new Headers` lowercases names and coalesces duplicates; its iterator yields
  // entries sorted by name, but sort explicitly to be robust to engine variance.
  return [...new Headers(headers)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function ttlToExpiry(revalidate: number | false | undefined): number {
  if (revalidate === undefined || revalidate === false) return Infinity;
  return now() + revalidate * 1000;
}

/**
 * Stable string key for arguments. Throws on non-serializable input rather than
 * returning a lossy `String()` fallback: `String([{a:1}])` and `String([{b:2}])`
 * both collapse to `"[object Object]"`, so two distinct calls would share one cache
 * entry and return each other's value — a silent correctness bug. Failing loud makes
 * the caller pass a serializable key instead.
 */
export function safeKey(args: unknown): string {
  let key: string | undefined;
  try {
    key = JSON.stringify(args);
  } catch (err) {
    throw new TypeError(
      "denext: cache key arguments must be JSON-serializable — a BigInt, circular " +
        "reference, or similar cannot be used as a cache key.",
      { cause: err },
    );
  }
  // JSON.stringify returns undefined (no throw) for a top-level undefined/function/
  // symbol; that can't serve as a key either.
  if (key === undefined) {
    throw new TypeError(
      "denext: cache key arguments serialized to nothing — a top-level undefined, " +
        "function, or symbol cannot be used as a cache key.",
    );
  }
  return key;
}
