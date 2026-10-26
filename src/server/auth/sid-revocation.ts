/**
 * Revoking one **stateless** cookie session by its id (`revokeSession(sid)` with no
 * `sessionStore`). Every stateless payload carries its own random `sid`; revoking one puts it on
 * the auth adapter's revocation list (`revokeSids`, the list SAML Single Logout writes), and a
 * read of a stateless session then looks its `sid` up there (`isSidRevoked`).
 *
 * **Keeping the default free.** The lookup is a query per request, which an app that never
 * revokes a single session should not pay. So the first `revokeSession(sid)` also writes a
 * durable marker row ({@linkcode REVOCATIONS_MARKER}) on the same list, and a read checks a
 * stateless session's `sid` only once the marker exists. Whether it exists is cached per process:
 * `true` for good once seen (the marker never expires), `false` for
 * {@linkcode MARKER_RECHECK_MS} before the adapter is asked again. Until an app first calls
 * `revokeSession(sid)`, a read costs at most one indexed lookup per process every
 * {@linkcode MARKER_RECHECK_MS}; an app whose adapter keeps no revocation list (or no adapter)
 * costs nothing. The instance that revokes sees it at once; another instance, only the very first
 * time, within {@linkcode MARKER_RECHECK_MS}. SAML sessions under Single Logout are checked on
 * every read regardless (`saml-revocation.ts`).
 *
 * **When the adapter can't answer.** A read fails closed — but with a stale answer first: every
 * successful lookup (the marker's, and each `sid`'s) is remembered per process (a bounded LRU of
 * {@linkcode MAX_REMEMBERED_ANSWERS} sids), and a lookup that throws answers with the remembered
 * one when it is at most {@linkcode STALE_ANSWER_MS} old — a revoked `sid` stays revoked, a live
 * one stays live, through a database blip or failover. With no answer that recent the read is
 * signed out (the cookie is kept, so the session comes back once the adapter does). Each failure
 * is logged at `warn` (at most one line per {@linkcode WARN_INTERVAL_MS} per adapter), and
 * `/_denext/health` reports `auth-revocation: "down"` (503) until a probe reaches the list again.
 *
 * @module
 */

import { registerHealthCheck } from "../health.ts";
import type { AuthAdapter } from "./adapter.ts";
import type { ResolvedAuthLogger } from "./options.ts";

/** The adapter methods revoking a stateless session by `sid` needs. */
export type SidRevocationAdapter = Required<Pick<AuthAdapter, "revokeSids" | "isSidRevoked">>;

/**
 * The revocation-list row that says this app has revoked a stateless session by id. Never a real
 * `sid` (those are 22 base64url characters, no `:`).
 */
export const REVOCATIONS_MARKER = "denext:revoke-session";

/** The marker's expiry, epoch seconds: 9999-12-31, so no pruning of expired rows removes it. */
const MARKER_EXPIRES_AT = 253_402_300_799;

/** How long a process trusts "no revocation yet" before asking the adapter again, ms. */
export const MARKER_RECHECK_MS = 10_000;

/** How old a remembered answer may be and still stand in for a lookup that throws, ms. */
export const STALE_ANSWER_MS = 60_000;

/** How many `sid` answers a process remembers per adapter (the oldest is dropped past it). */
export const MAX_REMEMBERED_ANSWERS = 10_000;

/** The least time between two "the revocation list could not be read" warnings per adapter, ms. */
export const WARN_INTERVAL_MS = 60_000;

/**
 * The least a revocation row lives, seconds: 400 days, the longest a browser keeps a cookie
 * (RFC 6265bis). A revocation written for a session's current `session.maxLifetime` would lapse
 * if the operator later raised the lifetime past it while the cookie kept sliding, so a row lives
 * the larger of the two; raising `maxLifetime` past 400 days after a revocation doesn't extend it.
 */
export const REVOCATION_FLOOR_SECONDS = 400 * 86_400;

/** The name of the readiness check `/_denext/health` reports the revocation list under. */
export const REVOCATION_HEALTH_CHECK = "auth-revocation";

/**
 * The adapter narrowed to the revocation-list methods, or `null` when it lacks either.
 *
 * @param adapter The configured adapter.
 * @returns The adapter, or `null`.
 */
export function sidRevocationOf(adapter: AuthAdapter | undefined): SidRevocationAdapter | null {
  return adapter && typeof adapter.revokeSids === "function" &&
      typeof adapter.isSidRevoked === "function"
    ? adapter as SidRevocationAdapter
    : null;
}

/**
 * When a revocation written now expires, epoch seconds: the larger of the session's
 * `maxLifetime` and {@linkcode REVOCATION_FLOOR_SECONDS} from now (see the floor's doc).
 *
 * @param nowSeconds The clock, epoch seconds.
 * @param maxLifetime The configured `session.maxLifetime`, seconds.
 * @returns The expiry.
 */
export function revocationExpiry(nowSeconds: number, maxLifetime: number): number {
  return nowSeconds + Math.max(maxLifetime, REVOCATION_FLOOR_SECONDS);
}

/** Per adapter: the marker was seen (`true`), or when it was last found missing (ms). */
const markers = new WeakMap<SidRevocationAdapter, true | number>();

/** One remembered `isSidRevoked` answer: what it was, and when (ms). */
interface Answer {
  revoked: boolean;
  at: number;
}

/** Per adapter: the remembered answers, insertion-ordered (a Map, so the oldest is first). */
const answers = new WeakMap<SidRevocationAdapter, Map<string, Answer>>();

/** Per adapter: whether the last lookup threw, when the last warning was logged (ms), the check. */
interface Outage {
  failing: boolean;
  warnedAt: number;
  unregister: () => void;
}
const outages = new WeakMap<SidRevocationAdapter, Outage>();

function answersOf(adapter: SidRevocationAdapter): Map<string, Answer> {
  let map = answers.get(adapter);
  if (!map) answers.set(adapter, map = new Map());
  return map;
}

/** Remember `sid`'s answer, dropping the oldest past the cap. */
function remember(adapter: SidRevocationAdapter, sid: string, answer: Answer): void {
  const map = answersOf(adapter);
  map.delete(sid);
  map.set(sid, answer);
  while (map.size > MAX_REMEMBERED_ANSWERS) map.delete(map.keys().next().value!);
}

/** `sid`'s remembered answer when it is recent enough to stand in for a failed lookup. */
function recentAnswer(
  adapter: SidRevocationAdapter,
  sid: string,
  now: number,
): Answer | undefined {
  const known = answers.get(adapter)?.get(sid);
  return known && now - known.at <= STALE_ANSWER_MS ? known : undefined;
}

/** The adapter's list could be read: the outage (if any) is over. */
function lookupSucceeded(adapter: SidRevocationAdapter): void {
  const outage = outages.get(adapter);
  if (outage) outage.failing = false;
}

/**
 * The adapter's list could not be read: warn (rate-limited), and mark the readiness check down
 * until a probe reaches the list again (registered once per adapter, on its first failure).
 */
function lookupFailed(
  adapter: SidRevocationAdapter,
  logger: ResolvedAuthLogger | undefined,
  error: unknown,
  now: number,
): void {
  let outage = outages.get(adapter);
  if (!outage) {
    const started: Outage = { failing: false, warnedAt: -Infinity, unregister: () => {} };
    started.unregister = registerHealthCheck(
      REVOCATION_HEALTH_CHECK,
      () => probe(adapter, started),
    );
    outages.set(adapter, outage = started);
  }
  outage.failing = true;
  if (now - outage.warnedAt < WARN_INTERVAL_MS) return;
  outage.warnedAt = now;
  logger?.warn(
    "denextAuth: the session revocation list could not be read; a stateless session answers " +
      `with its last answer of the past ${STALE_ANSWER_MS / 1000} s, else as signed out, until ` +
      "the adapter answers again",
    { error: error instanceof Error ? error.message : String(error) },
  );
}

/** The readiness check: healthy unless the last lookup failed and the list is still unreachable. */
async function probe(adapter: SidRevocationAdapter, outage: Outage): Promise<boolean> {
  if (!outage.failing) return true;
  try {
    await adapter.isSidRevoked(REVOCATIONS_MARKER);
    outage.failing = false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Put the stateless session `sid` on the revocation list until `expiresAt`, writing the marker
 * that turns the read-side check on first.
 *
 * @param adapter The adapter.
 * @param sid The session's id.
 * @param expiresAt Until when it stays revoked (its latest possible end), epoch seconds.
 */
export async function revokeStatelessSid(
  adapter: SidRevocationAdapter,
  sid: string,
  expiresAt: number,
): Promise<void> {
  if (markers.get(adapter) !== true) {
    await adapter.revokeSids([REVOCATIONS_MARKER], MARKER_EXPIRES_AT);
    markers.set(adapter, true);
  }
  await adapter.revokeSids([sid], expiresAt);
  // The revoking instance answers "revoked" at once, even through an outage that follows.
  remember(adapter, sid, { revoked: true, at: Date.now() });
}

/**
 * Whether this app has ever revoked a stateless session by id (the marker exists), so a read must
 * check a stateless session's `sid`. Cached as described in the module doc. A failing adapter
 * answers with the last successful answer when it is at most {@linkcode STALE_ANSWER_MS} old,
 * else throws (the caller fails closed).
 *
 * @param adapter The adapter.
 * @param now The clock, ms (a seam for tests).
 * @param logger Hears a (rate-limited) warning when the adapter fails.
 * @returns `true` once the marker exists.
 */
export async function revocationsInUse(
  adapter: SidRevocationAdapter,
  now: number = Date.now(),
  logger?: ResolvedAuthLogger,
): Promise<boolean> {
  const known = markers.get(adapter);
  if (known === true) return true;
  if (known !== undefined && now - known < MARKER_RECHECK_MS) return false;
  let found: boolean;
  try {
    found = (await adapter.isSidRevoked(REVOCATIONS_MARKER)) === true;
  } catch (error) {
    lookupFailed(adapter, logger, error, now);
    // The last successful answer was "missing" at `known`: recent enough, it still stands.
    if (known !== undefined && now - known <= STALE_ANSWER_MS) return false;
    throw error;
  }
  lookupSucceeded(adapter);
  markers.set(adapter, found || now);
  return found;
}

/**
 * Whether the stateless session `sid` is on the revocation list — the adapter's answer, with a
 * failed lookup answered by the remembered one when it is at most {@linkcode STALE_ANSWER_MS}
 * old (a revoked session stays revoked, a live one live), else re-thrown (the caller fails
 * closed).
 *
 * @param adapter The adapter.
 * @param sid The session's id.
 * @param logger Hears a (rate-limited) warning when the adapter fails.
 * @param now The clock, ms (a seam for tests).
 * @returns `true` when it was revoked.
 */
export async function sidRevoked(
  adapter: SidRevocationAdapter,
  sid: string,
  logger?: ResolvedAuthLogger,
  now: number = Date.now(),
): Promise<boolean> {
  let revoked: boolean;
  try {
    revoked = (await adapter.isSidRevoked(sid)) === true;
  } catch (error) {
    lookupFailed(adapter, logger, error, now);
    const known = recentAnswer(adapter, sid, now);
    if (known) return known.revoked;
    throw error;
  }
  lookupSucceeded(adapter);
  remember(adapter, sid, { revoked, at: now });
  return revoked;
}

/** Forget every remembered answer, marker and outage of `adapter` (tests). */
export function resetSidRevocationForTesting(adapter: SidRevocationAdapter): void {
  markers.delete(adapter);
  answers.delete(adapter);
  outages.get(adapter)?.unregister();
  outages.delete(adapter);
}
