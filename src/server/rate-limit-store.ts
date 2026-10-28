// The rate-limit store: the fixed-window counters `rateLimit()` (an API middleware) and the
// `@denext/auth` sign-in limiters count in. The in-memory store is the per-process default; a
// shared one (Redis, Postgres, Deno KV) implements the same {@linkcode RateLimitStore}.

/** The failure count at which an in-memory key counts as locked out (the limiter default `max`). */
const DEFAULT_LOCKOUT_AT = 5;
/** Keys the in-memory store tracks before it evicts. */
const DEFAULT_MAX_KEYS = 10_000;

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
  /**
   * Give back one unit counted for `key` (an attempt reserved up front that turned out to
   * succeed, or that another bucket refused). Optional: a store without it simply keeps the
   * unit, which only makes its limiter stricter.
   */
  decrement?(key: string): void | Promise<void>;
}

/** Options for {@linkcode inMemoryRateLimitStore}. */
export interface InMemoryRateLimitStoreOptions {
  /** Max tracked keys before the oldest are evicted (bounds memory under a key flood). Default 10000. */
  maxKeys?: number;
  /**
   * The failure count at which a key counts as **locked out** and becomes ineligible for
   * eviction, so a flood of fresh keys can never wash out a lockout that is doing its job.
   * Defaults to 5 (the limiter's default `max`); {@linkcode createRateLimiter} passes the
   * `max` it was configured with.
   */
  lockoutAt?: number;
}

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
  const lockoutAt = options.lockoutAt ?? DEFAULT_LOCKOUT_AT;
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
      const existing = live(key);
      if (!existing && windows.size >= maxKeys && !evict(windows, maxKeys, lockoutAt)) {
        // Every tracked key is mid-lockout and the cap is reached. Dropping one of them
        // to make room would hand an attacker a way to clear a lockout by flooding fresh
        // keys, so the new key is refused instead: the window it reports is already over
        // any budget, which is what a limiter reading it must treat as a 429.
        return { count: Number.MAX_SAFE_INTEGER, resetAt: Date.now() + windowMs };
      }
      const w = existing ?? { count: 0, resetAt: Date.now() + windowMs };
      w.count += 1;
      windows.delete(key); // re-insert so insertion order tracks recency for eviction
      windows.set(key, w);
      return { ...w };
    },
    reset: (key) => void windows.delete(key),
    decrement(key) {
      const w = live(key);
      if (w && w.count > 0) w.count -= 1;
    },
  };
}

/** Shrink to this fraction of `maxKeys` in one pass, so eviction is amortised. */
const EVICT_TO = 0.9;

/**
 * Make room for one more key in ONE pass over `windows` (insertion order is
 * least-recently-incremented first): every expired window, and every LIVE window still
 * below `lockoutAt`, is eligible; a key that is actually locked out is never dropped.
 *
 * The pass runs down to 90% of `maxKeys` rather than exactly `maxKeys`, so a store at the
 * cap amortises one scan over many increments instead of scanning on every one.
 *
 * @param windows The tracked windows, oldest first.
 * @param maxKeys The cap.
 * @param lockoutAt The count at which a key is locked out (and so unevictable).
 * @returns `true` when there is now room; `false` when every key is mid-lockout.
 */
function evict(
  windows: Map<string, RateLimitWindow>,
  maxKeys: number,
  lockoutAt: number,
): boolean {
  const now = Date.now();
  const target = Math.max(1, Math.floor(maxKeys * EVICT_TO));
  for (const [k, w] of windows) {
    if (windows.size < target) break;
    if (w.resetAt <= now || w.count < lockoutAt) windows.delete(k);
  }
  return windows.size < maxKeys;
}
