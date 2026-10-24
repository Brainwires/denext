// Auto-REST rate limits: a fixed-window request budget per client in front of the statements, on
// denext's rate-limit stores. A signed-in user is counted by their user id (so users behind one
// address don't share a budget; an anonymous sign-in by its address as well), anyone else by
// their client address (`clientIpForLimits()`: the socket peer, a trusted proxy's hop or the
// app's `rateLimitHeader`, an IPv6 address by its /64).
// The secret key (`service_role`) is a trusted server and is never limited. A request whose
// credential is refused (a 401) is charged to its address too, so a stream of forged tokens is
// bounded like anonymous reads. When no address can be told apart from a shared proxy's — an
// untrusted loopback/private peer — the address budget is skipped, as every per-address limit in
// denext is (`rateLimitLocalAddresses` / `trustForwardedHeaders` / `rateLimitHeader` change that).

import {
  activeAuthConfig,
  clientIpForLimits,
  inMemoryRateLimitStore,
  type RateLimitStore,
} from "@denext/denext/server";
import type { RequestIdentity } from "./identity.ts";
import { positiveOption } from "./options.ts";
import { RestError } from "./rest-parse.ts";

/** `backend({ rest: { rateLimit } })`. */
export interface RestRateLimitOptions {
  /** Requests one client (a user, or an address when signed out) may make per window. Default 1200. */
  max?: number;
  /** The window, in milliseconds. Default 60 000 (one minute). */
  windowMs?: number;
  /**
   * Where the counts live. Default: the shared store the app's `denextAuth({ rateLimit: { store }
   * })` configures (`redisRateLimitStore()`, `postgresRateLimitStore()`,
   * `denoKvRateLimitStore()` from `denext/server`), so every replica counts against one budget;
   * without one, a bounded in-memory store per process.
   */
  store?: RateLimitStore;
}

/** The resolved budget. */
export interface ResolvedRestRateLimit {
  /** Requests per client per window. */
  max: number;
  /** The window (ms). */
  windowMs: number;
  /** The configured store, or `undefined` for the in-memory default. */
  store: RateLimitStore | undefined;
}

/** Requests one client may make per window by default: 20 a second on average. */
const DEFAULT_MAX = 1200;
/** The default window: a minute. */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Validate `rest.rateLimit` and apply the defaults.
 *
 * @param o The option (`false`: no limit).
 * @returns The budget, or `null` when the routes are not limited.
 * @throws {TypeError} For a bad `max`, `windowMs` or `store`.
 */
export function resolveRestRateLimit(
  o: RestRateLimitOptions | false | undefined,
): ResolvedRestRateLimit | null {
  if (o === false) return null;
  if (o !== undefined && (typeof o !== "object" || o === null || Array.isArray(o))) {
    throw new TypeError("backend(): rest.rateLimit must be an object or false");
  }
  const store = o?.store;
  if (store !== undefined && typeof store?.increment !== "function") {
    throw new TypeError("backend(): rest.rateLimit.store must be a rate-limit store");
  }
  return {
    max: positiveOption(o?.max, DEFAULT_MAX, "backend(): rest.rateLimit.max"),
    windowMs: positiveOption(o?.windowMs, DEFAULT_WINDOW_MS, "backend(): rest.rateLimit.windowMs"),
    store,
  };
}

/** A 429: the budget is spent. `retryAfter` is the seconds until the window closes. */
class RestRateLimited extends RestError {
  /** Seconds until the client may try again (the `Retry-After` header). */
  readonly retryAfter: number;

  /**
   * Build the error.
   *
   * @param retryAfter Seconds until the window closes.
   */
  constructor(retryAfter: number) {
    super(
      429,
      "over_request_rate_limit",
      `Too many requests: try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}`,
      null,
      "Retry after the number of seconds in the Retry-After header.",
    );
    this.retryAfter = retryAfter;
  }
}

/** The client's address bucket, or `undefined` when per-address limits don't apply. */
function addressBucket(): string | undefined {
  try {
    return clientIpForLimits({ bucket: true });
  } catch {
    return undefined; // outside a request (a handler called directly): nothing to key on
  }
}

/**
 * The shared store the app's auth config names (`denextAuth({ rateLimit: { store } })`), or
 * `undefined` without `denextAuth()` or without a store there (its limiters then count in
 * memory too).
 */
function appRateLimitStore(): RateLimitStore | undefined {
  let config;
  try {
    config = activeAuthConfig();
  } catch {
    return undefined; // no denextAuth() in this process
  }
  const store = config.rateLimit === false ? undefined : config.rateLimit?.store;
  return typeof store?.increment === "function" ? store : undefined;
}

/** Counts requests against {@link ResolvedRestRateLimit}'s budget. */
export class RestLimiter {
  readonly #limit: ResolvedRestRateLimit;
  #store: RateLimitStore | undefined;

  /**
   * A limiter.
   *
   * @param limit The budget.
   */
  constructor(limit: ResolvedRestRateLimit) {
    this.#limit = limit;
    this.#store = limit.store;
  }

  /**
   * The store the counts go to, chosen at the first request (every plugin is set up by then):
   * the configured `store`, else the app's shared one ({@linkcode appRateLimitStore}), else a
   * bounded in-memory store for this process.
   */
  get store(): RateLimitStore {
    return this.#store ??= appRateLimitStore() ??
      inMemoryRateLimitStore({ lockoutAt: this.#limit.max });
  }

  /**
   * Count one request by `identity`; throws the 429 past the budget.
   *
   * @param identity Who the request is.
   * @throws {RestRateLimited} When the budget is spent.
   */
  async charge(identity: RequestIdentity): Promise<void> {
    if (identity.role === "service_role") return;
    if (identity.role !== "authenticated" || identity.userId === undefined) {
      return await this.chargeRefused();
    }
    await this.#count(`rest|user:${identity.userId}`);
    // An anonymous sign-in is minted on request: by its own budget alone, one address could
    // take a fresh budget per sign-in. It also counts against its address, as signed-out
    // visitors do.
    if (identity.claims.is_anonymous === true) await this.chargeRefused();
  }

  /**
   * Count a request against its address: a signed-out one, an anonymous sign-in's, or one whose
   * credential was refused.
   *
   * @throws {RestRateLimited} When the address's budget is spent.
   */
  async chargeRefused(): Promise<void> {
    const key = this.#addressKey();
    if (key !== undefined) await this.#count(key);
  }

  #addressKey(): string | undefined {
    const bucket = addressBucket();
    return bucket === undefined ? undefined : `rest|ip:${bucket}`;
  }

  async #count(key: string): Promise<void> {
    const window = await this.store.increment(key, this.#limit.windowMs);
    if (window.count <= this.#limit.max) return;
    throw new RestRateLimited(Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000)));
  }
}
