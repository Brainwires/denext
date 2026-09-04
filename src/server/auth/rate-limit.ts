/**
 * Brute-force protection for the Credentials sign-in endpoint: a fixed-window failure
 * counter keyed by client (IP + submitted identifier by default). After `max` failed
 * attempts in a window the endpoint answers a generic `429` until the window ends; a
 * successful sign-in resets the key. The counter lives in a pluggable
 * {@linkcode RateLimitStore} — the in-memory default is per-process (fine for a single
 * instance; back it with a shared store when running several replicas, otherwise each
 * replica counts on its own).
 *
 * @module
 */

import { remoteAddrOf } from "../remote-addr.ts";

/** One key's open failure window. */

export interface RateLimitWindow {
  /** Failures recorded so far in this window. */
  count: number;
  /** Epoch-ms at which the window closes (and the count resets). */
  resetAt: number;
}

/** Where the per-key failure counts live. All methods may be sync or async. */
export interface RateLimitStore {
  /** The open window for `key`, or `undefined` when none/expired. */
  get(key: string): RateLimitWindow | undefined | Promise<RateLimitWindow | undefined>;
  /**
   * Record one failure for `key`, opening a `windowMs` window when none is open, and
   * return the updated window.
   */
  increment(key: string, windowMs: number): RateLimitWindow | Promise<RateLimitWindow>;
  /** Forget `key` (called on a successful sign-in). */
  reset(key: string): void | Promise<void>;
}

/** Options for {@linkcode inMemoryRateLimitStore}. */
export interface InMemoryRateLimitStoreOptions {
  /** Max tracked keys before the oldest are evicted (bounds memory under a key flood). Default 10000. */
  maxKeys?: number;
}

/** Rate-limit settings on `AuthConfig.rateLimit`. */
export interface RateLimitOptions {
  /** Failed attempts allowed per key per window before a `429`. Default 5. */
  max?: number;
  /** Window length in ms. Default 15 minutes. */
  windowMs?: number;
  /**
   * Derive the limiter key from the request + the submitted credentials. The default
   * combines the client IP (the socket peer; behind a proxy declared with
   * `AuthConfig.trustForwardedHeaders`, the last `x-forwarded-for` hop) with the
   * submitted identifier (`email` / `username` / `login` / `identifier`, lower-cased).
   * Override when your proxy uses another header or you want a coarser/finer key.
   */
  keyGenerator?: (request: Request, credentials: Record<string, string>) => string;
  /** A shared store (Redis, SQL, …) instead of the per-process in-memory default. */
  store?: RateLimitStore;
}

/** A configured limiter (what the credentials route drives). */
export interface RateLimiter {
  /** `retryAfterSec` when `key` is currently locked out, else `null`. */
  lockedOut(key: string): Promise<number | null>;
  /** Record a failed attempt for `key`. */
  fail(key: string): Promise<void>;
  /** Clear `key` after a successful attempt. */
  succeed(key: string): Promise<void>;
}

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAX_KEYS = 10_000;
/** Which submitted field names the default key treats as "the account identifier". */
const IDENTIFIER_FIELDS = ["email", "username", "login", "identifier"];

/**
 * The default per-process {@linkcode RateLimitStore}: a bounded `Map` of fixed windows.
 * Expired windows are dropped on read; past `maxKeys` expired windows go first, then the
 * least-recently-incremented quiet keys — never a key mid-lockout —
 * so a flood of distinct identifiers can't grow memory without bound.
 *
 * @param options Key cap.
 * @returns A store to pass as `rateLimit.store`.
 */
export function inMemoryRateLimitStore(
  options: InMemoryRateLimitStoreOptions = {},
): RateLimitStore {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const windows = new Map<string, RateLimitWindow>();

  const live = (key: string): RateLimitWindow | undefined => {
    const w = windows.get(key);
    if (!w) return undefined;
    if (w.resetAt <= Date.now()) {
      windows.delete(key);
      return undefined;
    }
    return w;
  };

  return {
    get: (key) => live(key),
    increment(key, windowMs) {
      const w = live(key) ?? { count: 0, resetAt: Date.now() + windowMs };
      w.count += 1;
      windows.delete(key); // re-insert so insertion order tracks recency for eviction
      windows.set(key, w);
      if (windows.size > maxKeys) evict(windows, maxKeys, key);
      return { ...w };
    },
    reset: (key) => void windows.delete(key),
  };
}

/**
 * Shrink `windows` to `maxKeys`: expired windows go first, then the oldest keys — but a
 * key that is still counting failures is never evicted ahead of a quieter one, so a flood
 * of distinct identifiers can't wash out a lockout that is doing its job (`keep` is the
 * key just written and is exempt).
 */
function evict(windows: Map<string, RateLimitWindow>, maxKeys: number, keep: string): void {
  const now = Date.now();
  dropWhile(windows, maxKeys, (k, w) => k !== keep && w.resetAt <= now);
  const busiest = Math.max(...[...windows.values()].map((w) => w.count));
  dropWhile(windows, maxKeys, (k, w) => k !== keep && w.count < busiest);
  dropWhile(windows, maxKeys, (k) => k !== keep);
}

/** Delete entries matching `drop`, oldest first, until `windows` fits `maxKeys`. */
function dropWhile(
  windows: Map<string, RateLimitWindow>,
  maxKeys: number,
  drop: (key: string, w: RateLimitWindow) => boolean,
): void {
  for (const [k, w] of windows) {
    if (windows.size <= maxKeys) return;
    if (drop(k, w)) windows.delete(k);
  }
}

/** How {@linkcode defaultRateLimitKey} identifies the client. */
export interface RateLimitKeyOptions {
  /**
   * The app runs behind a proxy that overwrites/appends `x-forwarded-for`, so the LAST
   * hop of that header (the one the proxy added) is the client. Off by default: the
   * header is attacker-controlled without a proxy, so the socket peer is used instead.
   */
  trustForwardedHeaders?: boolean;
}

/**
 * The client IP: the socket peer denext's server loop recorded; behind a trusted proxy the
 * last `x-forwarded-for` hop (the one the proxy appended). Never the first hop — that is
 * whatever the client sent — so a per-request forged header can't dodge the limiter.
 * `"unknown"` only when neither is available (an embedder calling the handler directly).
 */
function clientIp(request: Request, options: RateLimitKeyOptions): string {
  if (options.trustForwardedHeaders) {
    const hops = request.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim());
    const last = hops?.filter(Boolean).at(-1);
    if (last) return last;
  }
  return remoteAddrOf(request) ?? "unknown";
}

/**
 * The default key: client IP + the submitted identifier (lower-cased). Pass
 * `trustForwardedHeaders` (mirrors `AuthConfig.trustForwardedHeaders`) when a proxy fronts
 * the app; otherwise the socket peer is the client.
 */
export function defaultRateLimitKey(
  request: Request,
  credentials: Record<string, string>,
  options: RateLimitKeyOptions = {},
): string {
  const field = IDENTIFIER_FIELDS.find((f) => typeof credentials[f] === "string");
  const id = field ? credentials[field].trim().toLowerCase() : "";
  return `${clientIp(request, options)}|${id}`;
}

/**
 * Build a {@linkcode RateLimiter} from the config options (defaults: 5 failures per
 * 15 minutes, in-memory store).
 *
 * @param options The `rateLimit` config.
 * @returns The limiter the credentials route drives.
 */
export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const max = options.max ?? DEFAULT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const store = options.store ?? inMemoryRateLimitStore();
  return {
    async lockedOut(key) {
      const w = await store.get(key);
      if (!w || w.count < max) return null;
      return Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000));
    },
    async fail(key) {
      await store.increment(key, windowMs);
    },
    async succeed(key) {
      await store.reset(key);
    },
  };
}
