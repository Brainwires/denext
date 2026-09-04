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
   * combines the client IP (`x-forwarded-for` first hop, else `x-real-ip`) with the
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
 * Expired windows are dropped on read; past `maxKeys` the oldest keys are evicted (FIFO)
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
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value as string);
      return { ...w };
    },
    reset: (key) => void windows.delete(key),
  };
}

/** The client IP a proxy/LB forwarded, or `"unknown"` when no such header is present. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The default key: client IP + the submitted identifier (lower-cased). */
export function defaultRateLimitKey(request: Request, credentials: Record<string, string>): string {
  const field = IDENTIFIER_FIELDS.find((f) => typeof credentials[f] === "string");
  const id = field ? credentials[field].trim().toLowerCase() : "";
  return `${clientIp(request)}|${id}`;
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
