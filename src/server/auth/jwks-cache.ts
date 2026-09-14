/**
 * The JWKS cache. A provider's signing keys used to be refetched on **every** login —
 * one extra round-trip per sign-in, and an IdP outage took logins down with it. This
 * module caches the key set per JWKS URL for the lifetime the provider's
 * `Cache-Control: max-age` asks for (1 hour when it says nothing), and refetches only
 * when a key is genuinely missing.
 *
 * The refetch is the part that has to be careful: the `kid` that triggers it comes out
 * of an **attacker-supplied** `id_token` header, so an unbounded "refetch on unknown
 * kid" is a free DoS amplifier pointed at the IdP. A miss therefore refetches **once**
 * and then throttles to at most one attempt per minute per URL; within the throttle
 * window the cached set is returned as-is and `verifyIdToken` rejects the token for
 * want of a key. Nothing here weakens verification — an unsigned or `alg:none` token is
 * still refused by `jwt.ts` no matter how many keys the cache holds.
 *
 * The `Cache-Control` helper is shared with the discovery-document cache in
 * `discovery.ts`, which caches on exactly the same terms.
 *
 * @module
 */

import type { ProviderFetch } from "./flow.ts";
import type { Jwk } from "./jwt.ts";

/** How long a document is cached when the provider sends no usable `max-age`: 1 hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Floor for a cached document, so a `max-age=0` provider can't disable the cache. */
const MIN_TTL_MS = 60 * 1000;
/** Ceiling for a cached document, so a key rotation is picked up within a day. */
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between two fetch attempts for one URL — the anti-DoS throttle. */
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;

/** `max-age=<n>` in a `Cache-Control` value (the first directive that matches wins). */
const MAX_AGE_RE = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i;

/**
 * How long a fetched document may be cached, from its `Cache-Control: max-age`,
 * clamped to [1 minute, 24 hours] so neither a hostile `max-age=0` nor an absurd
 * `max-age=31536000` decides denext's cache policy.
 *
 * @param headers The response headers.
 * @param fallbackMs The TTL to use when there is no usable `max-age` (default 1 hour).
 * @returns The cache lifetime in milliseconds.
 */
export function cacheTtlMs(headers: Headers, fallbackMs: number = DEFAULT_TTL_MS): number {
  const match = MAX_AGE_RE.exec(headers.get("cache-control") ?? "");
  const seconds = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Math.min(Math.max(fallbackMs, MIN_TTL_MS), MAX_TTL_MS);
  }
  return Math.min(Math.max(seconds * 1000, MIN_TTL_MS), MAX_TTL_MS);
}

/** One cached key set. */
interface JwksEntry {
  /** The keys as the provider served them. */
  keys: Jwk[];
  /** When the entry goes stale, ms epoch. */
  expiresAt: number;
  /** When a fetch was last *attempted* (success or failure) — the failure backoff. */
  lastAttemptAt: number;
  /**
   * When a **`kid` miss** last made us refetch, ms epoch, or `undefined` while none has.
   * The first miss on a key set always refetches (that is how a rotation is picked up);
   * every later one waits out the throttle, so an attacker-chosen `kid` costs the IdP at
   * most one request a minute.
   */
  lastMissAt?: number;
}

/** Process-wide, keyed by JWKS URL. Key sets are public data, so sharing them is safe. */
const jwksCache = new Map<string, JwksEntry>();

/** Options for {@link getJwks}. */
export interface GetJwksOptions {
  /**
   * The `kid` the `id_token` header names. A cached set without it counts as a miss and
   * triggers (at most) one throttled refetch — that is how a key rotation is picked up
   * before the TTL expires.
   */
  kid?: string;
  /** Current time in ms (injectable for tests; defaults to `Date.now()`). */
  now?: number;
}

/**
 * The provider's JWKS keys, cached per URL.
 *
 * @param jwksUrl The provider's JWKS endpoint (already validated / host-pinned by the caller).
 * @param doFetch The provider fetch (SSRF-safe, pinned to the provider's hosts).
 * @param options The `kid` being looked for and an injectable clock.
 * @returns The key set — freshly fetched, or the cached one when it is fresh, or the
 * stale one when a refetch is throttled or failed (verification then simply rejects).
 */
export function getJwks(
  jwksUrl: string,
  doFetch: ProviderFetch,
  options: GetJwksOptions = {},
): Promise<Jwk[]> {
  const now = options.now ?? Date.now();
  const entry = jwksCache.get(jwksUrl);
  if (!entry) return refreshJwks(jwksUrl, doFetch, now, undefined, false);
  if (entry.expiresAt > now) {
    if (!options.kid || entry.keys.some((key) => key.kid === options.kid)) {
      return Promise.resolve(entry.keys);
    }
    // A `kid` the cached set doesn't have: refetch once, then hold the line for a minute
    // and let `verifyIdToken` reject the token for want of a key.
    if (entry.lastMissAt !== undefined && now - entry.lastMissAt < MIN_REFETCH_INTERVAL_MS) {
      return Promise.resolve(entry.keys);
    }
    return refreshJwks(jwksUrl, doFetch, now, entry, true);
  }
  // Stale. A refetch that just failed backs off for a minute rather than turning every
  // login into a fresh failed round-trip.
  if (now - entry.lastAttemptAt < MIN_REFETCH_INTERVAL_MS) return Promise.resolve(entry.keys);
  return refreshJwks(jwksUrl, doFetch, now, entry, false);
}

/**
 * Fetch and cache the key set. A failure with a previous entry keeps that entry (and
 * records the attempt, so the throttle applies to failures too) — an IdP blip must not
 * turn every login into a fresh failed round-trip.
 *
 * `onMiss` says this refetch was provoked by an unknown `kid`, which is what arms the
 * per-minute throttle for the next one.
 */
async function refreshJwks(
  jwksUrl: string,
  doFetch: ProviderFetch,
  now: number,
  previous: JwksEntry | undefined,
  onMiss: boolean,
): Promise<Jwk[]> {
  const lastMissAt = onMiss ? now : previous?.lastMissAt;
  try {
    const { keys, ttlMs } = await fetchJwksDocument(jwksUrl, doFetch);
    jwksCache.set(jwksUrl, { keys, expiresAt: now + ttlMs, lastAttemptAt: now, lastMissAt });
    return keys;
  } catch (error) {
    if (!previous) throw error;
    jwksCache.set(jwksUrl, { ...previous, lastAttemptAt: now, lastMissAt });
    return previous.keys;
  }
}

/** One JWKS round-trip: the keys plus the lifetime the response asks for. */
async function fetchJwksDocument(
  jwksUrl: string,
  doFetch: ProviderFetch,
): Promise<{ keys: Jwk[]; ttlMs: number }> {
  const res = await doFetch(jwksUrl, {
    method: "GET",
    headers: { "accept": "application/json" },
  });
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  const body = await res.json().catch(() => ({})) as { keys?: Jwk[] };
  return {
    keys: Array.isArray(body.keys) ? body.keys : [],
    ttlMs: cacheTtlMs(res.headers),
  };
}
