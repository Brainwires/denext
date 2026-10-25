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
 * @module
 */

import type { AuthAdapter } from "./adapter.ts";

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

/** Per adapter: the marker was seen (`true`), or when it was last found missing (ms). */
const markers = new WeakMap<SidRevocationAdapter, true | number>();

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
}

/**
 * Whether this app has ever revoked a stateless session by id (the marker exists), so a read must
 * check a stateless session's `sid`. Cached as described in the module doc; a failing adapter
 * throws (the caller fails closed).
 *
 * @param adapter The adapter.
 * @param now The clock, ms (a seam for tests).
 * @returns `true` once the marker exists.
 */
export async function revocationsInUse(
  adapter: SidRevocationAdapter,
  now: number = Date.now(),
): Promise<boolean> {
  const known = markers.get(adapter);
  if (known === true) return true;
  if (known !== undefined && now - known < MARKER_RECHECK_MS) return false;
  if ((await adapter.isSidRevoked(REVOCATIONS_MARKER)) === true) {
    markers.set(adapter, true);
    return true;
  }
  markers.set(adapter, now);
  return false;
}
