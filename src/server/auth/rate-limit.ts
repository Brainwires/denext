/**
 * Brute-force protection for the sign-in endpoints: fixed-window counters in a pluggable
 * {@linkcode RateLimitStore}. Six limiters are built from one `rateLimit` config and
 * share this module's factory:
 *
 * - the **credentials** limiter counts *failed* `POST {basePath}/callback/:provider`
 *   attempts per client (IP + submitted identifier by default), 5 per 15 minutes;
 * - the **sign-in-start** limiter counts *every* `GET {basePath}/signin/:provider` per
 *   client IP, 100 per 15 minutes, so an unauthenticated visitor can't make the app mint
 *   PKCE/state transactions (or probe provider ids) without bound;
 * - the **session-read** limiter counts every `GET {basePath}/session` per client IP,
 *   300 per minute (`rateLimit.session`), so the unauthenticated poll endpoint can't be
 *   turned into free cookie-verification + store-read work;
 * - the **verification** limiter counts every outbound-token request (a password-reset,
 *   email-verification, sign-in link or one-time-code send) per address, 3 per 15 minutes (`rateLimit.verification`),
 *   plus an IP-wide bucket at {@linkcode IP_BUCKET_FACTOR}× that — so nobody can turn the
 *   app into a mail cannon aimed at one inbox, or at many;
 * - the **MFA** limiter bounds second-factor attempts per user, 5 per 5 minutes
 *   (`rateLimit.mfa`), plus the same kind of IP-wide bucket;
 * - the **captcha** limiter counts every captcha token sent to the provider per client IP,
 *   30 per minute (`rateLimit.captcha`), spent before the provider is asked — so a stream of
 *   unauthenticated requests can't drive unlimited calls to the verifier.
 *
 * Past the limit the endpoint answers a generic `429` with `Retry-After` until the window
 * ends; a successful credentials sign-in resets its key. The in-memory default store is
 * per-process (fine for a single instance; back it with a shared `store` when running
 * several replicas, otherwise each replica counts on its own).
 *
 * **Client identity.** Every per-IP key goes through {@linkcode clientIpBucket}: IPv4 as
 * given, IPv6 normalised and bucketed by /64 (see there for why). And the two per-IP
 * budgets are **skipped entirely** for a request from a loopback/private peer with no trusted
 * `x-forwarded-for` hop ({@linkcode proxiedWithoutTrust}, the limit-address rule of
 * `rateLimit()` and `clientIpForLimits()`) — behind such a proxy every user would otherwise
 * share one bucket, which turns the limiter into an app-wide outage rather than a defence.
 * The app's `rateLimitHeader` / `rateLimitLocalAddresses` (the per-address limit policy every
 * limiter shares) change both: the header's address keys every per-IP budget whenever a request
 * carries one, and a local peer is counted by its own address instead of skipped.
 *
 * @module
 */

import { clientAddrOf, ipBucket, limitAddrOf, remoteAddrOf } from "../remote-addr.ts";
import { currentLimitPolicy, trustsForwardedHeaders } from "../request-context.ts";

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
  /**
   * Tune the **sign-in-start** limiter — the per-IP budget for `GET
   * {basePath}/signin/:provider`, which is counted on every hit rather than only on
   * failures. `max`/`windowMs`/`keyGenerator` above belong to the credentials limiter and
   * never apply here; `store` is shared by both (their keys are namespaced apart).
   */
  signin?: {
    /** Sign-in starts allowed per client IP per window before a `429`. Default 20. */
    max?: number;
    /** Window length in ms. Default 15 minutes. */
    windowMs?: number;
  };
  /**
   * Tune the **session-read** limiter — the per-IP budget for `GET {basePath}/session`,
   * counted on every hit. Default 300 per minute, which is far above any sane
   * `SessionProvider` poll and still bounds an unauthenticated flood. Like `signin`, it
   * shares `store` and ignores `max`/`windowMs`/`keyGenerator`.
   */
  session?: {
    /** Session reads allowed per client IP per window before a `429`. Default 300. */
    max?: number;
    /** Window length in ms. Default 1 minute. */
    windowMs?: number;
  };
  /**
   * Tune the **verification** limiter — outbound-token requests (password-reset,
   * email-verification, magic-link and one-time-code sends), counted on every request for an address whether or not
   * the address has an account, so a throttled unknown address answers exactly like a
   * throttled known one. The IP-wide bucket allows `IP_BUCKET_FACTOR` (10)× `max`. Shares
   * `store`; ignores the credentials `max`/`windowMs`/`keyGenerator`.
   */
  verification?: {
    /** Requests allowed per address per window before a `429`. Default 3. */
    max?: number;
    /** Window length in ms. Default 15 minutes. */
    windowMs?: number;
  };
  /**
   * Tune the **MFA** limiter — second-factor attempts per user, plus an IP-wide bucket at
   * `IP_BUCKET_FACTOR` (10)× `max`. Shares `store`; ignores the credentials fields.
   */
  mfa?: {
    /** Attempts allowed per user per window before a `429`. Default 5. */
    max?: number;
    /** Window length in ms. Default 5 minutes. */
    windowMs?: number;
  };
  /**
   * Tune the **captcha** limiter — the per-IP budget spent on every captcha token denext is
   * about to send to the provider (denext's own endpoints and `/auth/v1` alike), BEFORE the
   * provider is called, so no unauthenticated request stream can drive unlimited verifier
   * calls. A missing or oversized token is refused without spending. `false` turns this one
   * budget off. Shares `store`; ignores the credentials fields. Skipped, like every per-IP
   * budget, for a loopback/private peer with no trusted proxy hop.
   */
  captcha?: {
    /** Verifier calls allowed per client IP per window before a `429`. Default 30. */
    max?: number;
    /** Window length in ms. Default 1 minute. */
    windowMs?: number;
  } | false;
}

/** A configured limiter (what the credentials route drives). */
export interface RateLimiter {
  /**
   * `retryAfterSec` when `key` is currently locked out, else `null`. `maxFactor` scales the
   * configured `max` for this key (the IP-wide bucket uses a looser threshold).
   */
  lockedOut(key: string, maxFactor?: number): Promise<number | null>;
  /** Record a failed attempt for `key`. */
  fail(key: string): Promise<void>;
  /** Clear `key` after a successful attempt. */
  succeed(key: string): Promise<void>;
  /**
   * Count one attempt for `key` FIRST, then refuse when the count is over budget — the
   * atomic form of `lockedOut` + `fail`. Concurrent requests each see their own count, so a
   * burst can't all pass the check before any of them is counted.
   *
   * @returns `retryAfterSec` when this attempt is over budget, else `null`.
   */
  hit(key: string, maxFactor?: number): Promise<number | null>;
  /** Give back one unit {@linkcode RateLimiter.hit} counted for `key` (the store's `decrement`). */
  refund(key: string): Promise<void>;
}

const DEFAULT_MAX = 5;
/** Sign-in starts one client IP may make per window before a `429`. */
const DEFAULT_SIGNIN_MAX = 100;
/** Session reads one client IP may make per window before a `429`. */
const DEFAULT_SESSION_MAX = 300;
const DEFAULT_WINDOW_MS = 15 * 60_000;
/** The session-read limiter's window: a minute, not the sign-in quarter-hour. */
const DEFAULT_SESSION_WINDOW_MS = 60_000;
/** Outbound-token requests one address may trigger per window before a `429`. */
const DEFAULT_VERIFICATION_MAX = 3;
/** Second-factor attempts one user may make per window before a `429`. */
const DEFAULT_MFA_MAX = 5;
/** The MFA limiter's window: five minutes. */
const DEFAULT_MFA_WINDOW_MS = 5 * 60_000;
/** Captcha verifier calls one client IP may trigger per window before a `429`. */
const DEFAULT_CAPTCHA_MAX = 30;
/** The captcha limiter's window: a minute. */
const DEFAULT_CAPTCHA_WINDOW_MS = 60_000;
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
  const lockoutAt = options.lockoutAt ?? DEFAULT_MAX;
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
 * whatever the client sent — so a per-request forged header can't dodge the limiter. When the
 * app names a `rateLimitHeader`, the address in it comes first (the limit address,
 * {@linkcode limitAddrOf}, which otherwise equals the client address whenever it is defined).
 * `"unknown"` only when none is available (an embedder calling the handler directly).
 */
function resolveClientIp(request: Request, options: RateLimitKeyOptions): string {
  const trust = options.trustForwardedHeaders === true;
  return limitAddrOf(request, trust, currentLimitPolicy()) ?? clientAddrOf(request, trust) ??
    "unknown";
}

/**
 * How many times the per-identifier `max` a single client IP may fail across ALL identifiers
 * before it is locked out. The per-identifier key alone lets an attacker who varies the
 * identifier (or the identifier FIELD — `email` vs `username`) open a fresh bucket per
 * attempt; this second, IP-wide bucket bounds that.
 */
export const IP_BUCKET_FACTOR = 10;

/**
 * The client's **limiter bucket**: {@link resolveClientIp}, normalised — an IPv6 address collapses
 * to its /64 prefix, so the many spellings of one address share one budget and a /64
 * allocation can't mint a fresh one per request. Every per-IP limiter key is built on this
 * rather than on the raw address.
 *
 * @param request The incoming request.
 * @param options Whether a fronting proxy's `x-forwarded-for` may be trusted.
 * @returns The bucket string to key a limiter on.
 */
export function clientIpBucket(request: Request, options: RateLimitKeyOptions = {}): string {
  return ipBucket(resolveClientIp(request, options));
}

/** The IP-wide lockout bucket for `request` (see {@link IP_BUCKET_FACTOR}). */
export function ipBucketKey(request: Request, options: RateLimitKeyOptions = {}): string {
  return `ip|${clientIpBucket(request, options)}`;
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
  return `${clientIpBucket(request, options)}|${id}`;
}

/**
 * The sign-in-START lockout bucket for `request` — the client IP alone, namespaced away
 * from the credentials keys. The identifier can't take part: `GET /signin/:provider`
 * carries no credentials, only a provider id an attacker chooses freely.
 *
 * @param request The incoming sign-in-start request.
 * @param options Whether a fronting proxy's `x-forwarded-for` may be trusted.
 * @returns The limiter key.
 */
export function signinStartKey(request: Request, options: RateLimitKeyOptions = {}): string {
  return `signin|${clientIpBucket(request, options)}`;
}

/**
 * The session-READ bucket for `request` — the client IP alone, namespaced away from both
 * other budgets. `GET {basePath}/session` is unauthenticated and does real work (a cookie
 * verification, a store read, and on a stale session a re-issue), so it gets its own,
 * looser budget: 300 hits per client per minute by default, tunable with `rateLimit.session`.
 *
 * @param request The incoming session request.
 * @param options Whether a fronting proxy's `x-forwarded-for` may be trusted.
 * @returns The limiter key.
 */
export function sessionReadKey(request: Request, options: RateLimitKeyOptions = {}): string {
  return `session|${clientIpBucket(request, options)}`;
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
  const store = options.store ?? inMemoryRateLimitStore({ lockoutAt: max });
  const retryAfter = (w: RateLimitWindow) =>
    Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000));
  return {
    async lockedOut(key, maxFactor = 1) {
      const w = await store.get(key);
      return !w || w.count < max * maxFactor ? null : retryAfter(w);
    },
    async hit(key, maxFactor = 1) {
      const w = await store.increment(key, windowMs);
      return w.count > max * maxFactor ? retryAfter(w) : null;
    },
    async refund(key) {
      await store.decrement?.(key);
    },
    async fail(key) {
      await store.increment(key, windowMs);
    },
    async succeed(key) {
      await store.reset(key);
    },
  };
}

/**
 * The slice of `AuthConfig` the limiters read. Kept structural so this module never
 * imports the config type (which imports {@linkcode RateLimitOptions} from here).
 */
export interface RateLimitConfig {
  /** The app's `rateLimit` config, or `false` to disable every limiter. */
  rateLimit?: RateLimitOptions | false;
  /** Whether a fronting proxy's `x-forwarded-for` may be believed. */
  trustForwardedHeaders?: boolean;
}

/**
 * Whether auth may believe `x-forwarded-for` for this request: the auth config's own
 * `trustForwardedHeaders` when it sets one, else the app-level `trustForwardedHeaders` /
 * `DENEXT_TRUST_PROXY=1` the request context carries — so the auth limiters and
 * {@linkcode clientIp} agree on who the client is unless auth deliberately overrides it.
 *
 * @param config The auth config slice (its `trustForwardedHeaders`).
 * @returns The effective trust decision.
 */
export function authTrustsProxy(config: { trustForwardedHeaders?: boolean }): boolean {
  return trustsForwardedHeaders(config.trustForwardedHeaders);
}

/** The limiters one auth config drives; `null` where `rateLimit: false` disabled them. */
interface ConfigLimiters {
  /** Failed credentials attempts. */
  credentials: RateLimiter | null;
  /** Sign-in-start hits. */
  signinStart: RateLimiter | null;
  /** Session-read hits. */
  sessionRead: RateLimiter | null;
  /** Outbound-token requests (password-reset / email-verification sends). */
  verification: RateLimiter | null;
  /** Second-factor attempts. */
  mfa: RateLimiter | null;
  /** Captcha verifier calls. */
  captcha: RateLimiter | null;
}

// One pair per config object (the plugin hands the same `config` to every request), built
// lazily so an app that opts out (`rateLimit: false`) allocates no stores at all.
const limiters = new WeakMap<RateLimitConfig, ConfigLimiters>();

/**
 * One of the secondary budgets: its own `max`/`windowMs` (tuned by a `rateLimit.<name>`
 * block, else the defaults given) over the one optional shared store.
 */
function budget(
  options: RateLimitOptions,
  tuning: { max?: number; windowMs?: number } | undefined,
  max: number,
  windowMs: number,
): RateLimiter {
  return createRateLimiter({
    max: tuning?.max ?? max,
    windowMs: tuning?.windowMs ?? windowMs,
    store: options.store,
  });
}

/** Build every limiter for a config — one factory, six budgets, one (optional) shared store. */
function buildLimiters(config: RateLimitConfig): ConfigLimiters {
  if (config.rateLimit === false) {
    return {
      credentials: null,
      signinStart: null,
      sessionRead: null,
      verification: null,
      mfa: null,
      captcha: null,
    };
  }
  const options = config.rateLimit ?? {};
  return {
    credentials: createRateLimiter(options),
    signinStart: budget(options, options.signin, DEFAULT_SIGNIN_MAX, DEFAULT_WINDOW_MS),
    sessionRead: budget(options, options.session, DEFAULT_SESSION_MAX, DEFAULT_SESSION_WINDOW_MS),
    verification: budget(
      options,
      options.verification,
      DEFAULT_VERIFICATION_MAX,
      DEFAULT_WINDOW_MS,
    ),
    mfa: budget(options, options.mfa, DEFAULT_MFA_MAX, DEFAULT_MFA_WINDOW_MS),
    captcha: options.captcha === false
      ? null
      : budget(options, options.captcha, DEFAULT_CAPTCHA_MAX, DEFAULT_CAPTCHA_WINDOW_MS),
  };
}

/** The memoised limiter pair for `config`. */
function limitersFor(config: RateLimitConfig): ConfigLimiters {
  let pair = limiters.get(config);
  if (!pair) {
    pair = buildLimiters(config);
    limiters.set(config, pair);
  }
  return pair;
}

/**
 * The credentials brute-force limiter for an auth config.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` disabled it.
 */
export function credentialsLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).credentials;
}

/**
 * The sign-in-start limiter for an auth config: 100 hits per client IP per 15 minutes by
 * default, tunable with `rateLimit.signin`.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` disabled it.
 */
export function signinStartLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).signinStart;
}

/**
 * The session-read limiter for an auth config: 300 hits per client IP per minute by
 * default, tunable with `rateLimit.session`.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` disabled it.
 */
export function sessionReadLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).sessionRead;
}

/**
 * The verification (outbound-token) limiter for an auth config: 3 requests per address
 * per 15 minutes by default, tunable with `rateLimit.verification`. Drive it with
 * {@linkcode subjectBucketKeys}`("verify", …)` + {@linkcode consumeHitBudget}.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` disabled it.
 */
export function verificationLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).verification;
}

/**
 * The MFA limiter for an auth config: 5 second-factor attempts per user per 5 minutes by
 * default, tunable with `rateLimit.mfa`. Key it with {@linkcode subjectBucketKeys}`("mfa", …)`.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` disabled it.
 */
export function mfaLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).mfa;
}

/**
 * The captcha limiter for an auth config: 30 verifier calls per client IP per minute by
 * default, tunable with `rateLimit.captcha`. Drive it with {@linkcode spendCaptchaBudget}.
 *
 * @param config The app's auth config.
 * @returns The limiter, or `null` when `rateLimit: false` or `rateLimit.captcha: false`
 *   disabled it.
 */
function captchaLimiter(config: RateLimitConfig): RateLimiter | null {
  return limitersFor(config).captcha;
}

/**
 * Spend one unit of the per-IP captcha budget for a token about to go to the provider. Like
 * every per-IP budget it is skipped for a request from an undeclared proxy
 * ({@linkcode proxiedWithoutTrust}), and it keys on {@linkcode clientIpBucket} (so
 * `rateLimitHeader` and `trustForwardedHeaders` apply).
 *
 * @param request The incoming request.
 * @param config The app's auth config.
 * @returns Seconds until the budget refills when refused, else `null` (go ahead).
 */
export async function spendCaptchaBudget(
  request: Request,
  config: RateLimitConfig,
): Promise<number | null> {
  const limiter = captchaLimiter(config);
  if (!limiter || proxiedWithoutTrust(request, config)) return null;
  const key = `captcha|${
    clientIpBucket(request, { trustForwardedHeaders: authTrustsProxy(config) })
  }`;
  return await limiter.hit(key);
}

/** Which per-subject budget a {@linkcode SubjectBucketKeys} pair counts against. */
export type SubjectBudget = "verify" | "mfa";

/** The two buckets one per-subject attempt counts against. */
export interface SubjectBucketKeys {
  /** The subject's own bucket (a normalised address, or a user id). */
  key: string;
  /**
   * The client-IP bucket (checked at `IP_BUCKET_FACTOR`× the budget), or `null` when there
   * is no request to key on or the request came through an undeclared proxy.
   */
  ipKey: string | null;
}

/**
 * The bucket pair for one per-subject attempt: `<budget>|<subject>` plus an IP-wide
 * `<budget>-ip|<client bucket>`, namespaced away from every other limiter's keys. The
 * IP-wide bucket is dropped behind an undeclared reverse proxy ({@linkcode proxiedWithoutTrust})
 * — every client would share it there — and when there is no request (a server function
 * called outside one), leaving the subject bucket to bound the attempt alone.
 *
 * @param budget Which limiter the keys are for.
 * @param subject The normalised address (`"verify"`) or the user id (`"mfa"`).
 * @param request The incoming request, when there is one.
 * @param config The app's auth config (its `trustForwardedHeaders`).
 * @returns The two keys.
 */
export function subjectBucketKeys(
  budget: SubjectBudget,
  subject: string,
  request: Request | undefined,
  config: RateLimitConfig,
): SubjectBucketKeys {
  const ipKey = request && !proxiedWithoutTrust(request, config)
    ? `${budget}-ip|${clientIpBucket(request, { trustForwardedHeaders: authTrustsProxy(config) })}`
    : null;
  return { key: `${budget}|${subject}`, ipKey };
}

/** The buckets one attempt counts against: an optional subject bucket plus the IP-wide one. */
export interface AttemptKeys {
  /** The subject's own bucket, or `null` when the attempt has none (a magic-link redeem). */
  readonly key: string | null;
  /** The client-IP bucket (checked at `IP_BUCKET_FACTOR`× the budget), or `null`. */
  readonly ipKey: string | null;
}

/**
 * Spend one unit of a budget for an attempt that is about to run: count it against the
 * subject bucket, then the IP-wide one, refusing as soon as either is over. Counting comes
 * FIRST ({@linkcode RateLimiter.hit}), so a concurrent burst can't all pass the check before
 * any of it is counted. A hit-counted budget (every attempt counts) stops here; a
 * failure-counted one (a password, a one-time code) also calls {@linkcode settleAttempt} when
 * the attempt succeeds.
 *
 * @param limiter The limiter, or `null` when rate limiting is off (never refuses).
 * @param keys The subject + IP buckets ({@linkcode subjectBucketKeys}).
 * @returns Seconds until the budget refills when refused, else `null` (go ahead).
 */
export async function consumeHitBudget(
  limiter: RateLimiter | null,
  keys: AttemptKeys,
): Promise<number | null> {
  if (!limiter) return null;
  const own = keys.key === null ? null : await limiter.hit(keys.key);
  if (own !== null) return own;
  const shared = keys.ipKey === null ? null : await limiter.hit(keys.ipKey, IP_BUCKET_FACTOR);
  // The IP refused, so the attempt never ran: don't charge the subject for it.
  if (shared !== null && keys.key !== null) await limiter.refund(keys.key);
  return shared;
}

/**
 * Settle a failure-counted attempt that succeeded: clear the subject bucket and give the
 * IP-wide bucket back the unit {@linkcode consumeHitBudget} reserved, so only failures count.
 *
 * @param limiter The limiter, or `null` when rate limiting is off.
 * @param keys The buckets the attempt was charged to.
 */
export async function settleAttempt(limiter: RateLimiter | null, keys: AttemptKeys): Promise<void> {
  if (!limiter) return;
  if (keys.key !== null) await limiter.succeed(keys.key);
  if (keys.ipKey !== null) await limiter.refund(keys.ipKey);
}

/** Warn about an undeclared proxy at most once per process. */
let warnedUntrustedProxy = false;

/**
 * Whether this request's per-IP budgets must be skipped: it has a recorded socket peer, but no
 * address to key a per-address limit on ({@linkcode limitAddrOf}, the rule `rateLimit()`,
 * `clientIpForLimits()` and Live follow). That is a loopback, private, link-local or
 * unique-local peer with no trusted `x-forwarded-for` hop naming the client: most likely a
 * reverse proxy the app has not declared (or local development), whether or not it sets the
 * header.
 *
 * In that shape the "client IP" every per-IP limiter would key on is the proxy, so all
 * traffic shares one bucket and the 21st sign-in start *app-wide* is a 429 for fifteen
 * minutes. The per-IP budgets are therefore skipped for such a request (the credentials
 * limiter, whose key also carries the submitted identifier, keeps working), and the
 * operator is told once how to get the limiter back. A request with no recorded peer (a
 * handler called directly) keeps them, keyed `unknown`.
 *
 * @param request The incoming request.
 * @param config The app's auth config (its `trustForwardedHeaders`).
 * @returns `true` when the per-IP budgets must be skipped for this request.
 */
export function proxiedWithoutTrust(request: Request, config: RateLimitConfig): boolean {
  const peer = remoteAddrOf(request);
  if (
    peer === undefined ||
    limitAddrOf(request, authTrustsProxy(config), currentLimitPolicy()) !== undefined
  ) {
    return false;
  }
  if (!warnedUntrustedProxy) {
    warnedUntrustedProxy = true;
    console.warn(
      `denextAuth: requests arrive from a loopback/private address (${peer}), a reverse ` +
        "proxy or local development, with no trusted `x-forwarded-for` hop, so every client " +
        "would share ONE per-IP rate-limit bucket: the per-IP budgets are off for them. Behind " +
        "a proxy that overwrites the header, set `trustForwardedHeaders: true` (the app's, or " +
        "denextAuth's own) or `DENEXT_TRUST_PROXY=1`; behind one that sets a client-address " +
        "header, name it in the app's `rateLimitHeader`; to limit these peers by their own " +
        "address, set `rateLimitLocalAddresses: true`; or give " +
        "`rateLimit.keyGenerator`/`rateLimit.signin` a key that suits your proxy.",
    );
  }
  return true;
}
