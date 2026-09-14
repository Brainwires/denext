/**
 * Auth session issuance/reads on top of denext's signed-cookie sessions
 * ({@link ../session.ts | getSession}). The payload is signed (tamper-evident) but
 * **readable** — it stores only a non-sensitive {@link AuthUser} + provider +
 * expiry, never tokens or secrets.
 *
 * Two modes, chosen by the resolved session store (`AuthConfig.sessionStore`, or an
 * adapter's `sessions` under `session.strategy: "database"`):
 * - **stateless** (default): the cookie carries the whole {@link AuthSession};
 * - **store-backed**: the cookie carries only `{ sid }` — a random id — and the
 *   payload lives in the {@link SessionStore}, so a session can be revoked.
 *
 * **Payload versioning.** Sessions issued from 2.5 carry `v: 2` and `issuedAt`; the
 * cookie's name, signing secret and MAC domain are unchanged, so a session issued by an
 * older denext still verifies and is read **v1-tolerantly** — a missing `issuedAt` is
 * inferred from `expiresAt - maxAge`, a missing `amr` reads as `[]`, and a missing
 * `mfaPending` means the session is complete.
 *
 * **Sliding expiry.** With `session.updateAge` set, {@link refreshIfStale} re-issues an
 * aged-but-still-live session with a fresh lifetime — but only on a path that still owns
 * its response (see its doc comment).
 *
 * @module
 */

import { getSession } from "../session.ts";
import { randomToken } from "./oauth.ts";
import { cookieSessionOptions, resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { sessionExpired, type SessionStore } from "./session-store.ts";
import type { AuthConfig, AuthSession, AuthUser } from "./types.ts";

/** What the signed cookie carries: the payload (stateless) or a store id. */
type CookieData = AuthSession | { sid: string };

/** The signed-cookie options for this config's session cookie. */
function sessionOptions(config: AuthConfig) {
  const options = resolveAuthOptions(config);
  return cookieSessionOptions(config, options.cookies.session, options.maxAge);
}

/** The store id in a cookie payload, or `undefined` for a stateless payload. */
function storeId(data: CookieData | null): string | undefined {
  return data && "sid" in data && typeof data.sid === "string" ? data.sid : undefined;
}

/**
 * Fill in the fields a pre-2.5 payload doesn't carry, so every reader can treat a v1 and
 * a v2 session alike. `mfaPending` needs nothing: absent means "complete".
 */
function normalizeSession(session: AuthSession, maxAge: number): AuthSession {
  if (session.issuedAt !== undefined && session.amr !== undefined) return session;
  return {
    ...session,
    issuedAt: session.issuedAt ?? session.expiresAt - maxAge,
    amr: session.amr ?? [],
  };
}

/** `session` when it is a well-formed, unexpired payload — else null. */
function liveSession(session: AuthSession | undefined, maxAge: number): AuthSession | null {
  if (!session || !session.user) return null;
  return sessionExpired(session) ? null : normalizeSession(session, maxAge);
}

/** Resolve the cookie data to a session: a store lookup, or the stateless payload. */
async function resolveSession(
  data: CookieData | null,
  store: SessionStore | undefined,
  maxAge: number,
): Promise<AuthSession | null> {
  if (!data) return null;
  if (!store) return "sid" in data ? null : liveSession(data, maxAge);
  const sid = storeId(data);
  if (!sid) return null; // a stateless cookie is not honored once a store is configured
  const stored = liveSession(await store.get(sid), maxAge);
  return stored ? { ...stored, sessionId: sid } : null;
}

/**
 * Read the current auth session, or `null` when absent/expired/invalid/revoked.
 *
 * @param config The app's auth config.
 * @returns The session, normalised to the current payload shape, or `null`.
 */
export async function readAuthSession(config: AuthConfig): Promise<AuthSession | null> {
  const options = resolveAuthOptions(config);
  const session = await getSession<CookieData>(sessionOptions(config));
  return await resolveSession(session.data, options.sessionStore, options.maxAge);
}

/**
 * Issue (sign + set) a session for `user` from `provider`, applying the session callback.
 *
 * @param config The app's auth config.
 * @param user The authenticated user.
 * @param provider The provider id that authenticated them.
 * @returns The issued session (carrying `sessionId` when store-backed).
 */
export async function issueAuthSession(
  config: AuthConfig,
  user: AuthUser,
  provider: string,
): Promise<AuthSession> {
  const options = resolveAuthOptions(config);
  const maxAge = options.maxAge;
  const now = Math.floor(Date.now() / 1000);
  let payload: AuthSession = {
    user,
    provider,
    expiresAt: now + maxAge,
    v: 2,
    issuedAt: now,
  };
  if (config.callbacks?.session) payload = await config.callbacks.session(payload);
  if (!Number.isFinite(payload.expiresAt)) {
    // A callback that dropped/mangled the expiry must not yield a never-expiring or a
    // store-rejected (500) session: restore the configured lifetime.
    payload = { ...payload, expiresAt: Math.floor(Date.now() / 1000) + maxAge };
  }
  const session = await getSession<CookieData>(sessionOptions(config));
  if (!options.sessionStore) {
    await session.set(payload);
    return payload;
  }
  // Store-backed: a fresh random id per login (no fixation), the payload server-side.
  const sid = randomToken();
  await options.sessionStore.create(sid, payload);
  await session.set({ sid });
  return { ...payload, sessionId: sid };
}

/**
 * How long ago this session was established, in seconds. A v1 payload carries no
 * `issuedAt`, so it is inferred from `expiresAt - maxAge` — the same inference
 * {@link normalizeSession} makes.
 */
function sessionAge(session: AuthSession, maxAge: number, nowSeconds: number): number {
  return nowSeconds - (session.issuedAt ?? session.expiresAt - maxAge);
}

/**
 * Whether `session` may slide forward now: sliding is configured (`session.updateAge`),
 * the session is still live, it has aged past the threshold, and it is fully
 * authenticated — a half-authenticated (`mfaPending`) session is never extended, so the
 * window to finish a second factor can't be slid open indefinitely.
 */
function shouldRefresh(
  options: ResolvedAuthOptions,
  session: AuthSession,
  nowMs: number,
): boolean {
  if (options.updateAge <= 0 || session.mfaPending) return false;
  if (sessionExpired(session, nowMs)) return false;
  return sessionAge(session, options.maxAge, Math.floor(nowMs / 1000)) >= options.updateAge;
}

/**
 * Sliding expiry: re-issue `session` with a fresh `issuedAt`/`expiresAt` (a full `maxAge`
 * from now) once it has aged past `session.updateAge`, so an active user is never logged
 * out mid-session while an idle one still expires on time. Returns the session unchanged
 * when sliding is off (the default), when the session is expired, half-authenticated, or
 * simply not stale yet — so callers can pass every session through it.
 *
 * A store-backed session keeps the **same** `sid` (the record is rewritten in place, and
 * the cookie re-sent to renew its `Max-Age`): rotating it would invalidate the user's
 * other tabs for no benefit, since fixation is already prevented at login by minting a
 * fresh id there.
 *
 * **Only call this on a path that still owns its response.** The refreshed cookie is
 * queued on the request's outgoing headers (`cookies().set()`), which the pipeline
 * attaches when the response is finalized — so a `Set-Cookie` produced *after* the
 * response headers have flushed (a streamed Server Component calling bare `auth()`) is
 * dropped silently. That is why `auth()` never refreshes: the refresh happens on
 * `GET {basePath}/session`, in `requireAuth()`/`requireSession()`, and in the explicit
 * `updateAuthSession()`.
 *
 * @param config The app's auth config.
 * @param session The session just read for this request.
 * @param nowMs The current time in ms (injectable for tests).
 * @returns The refreshed session, or `session` itself when nothing was re-issued.
 */
export async function refreshIfStale(
  config: AuthConfig,
  session: AuthSession,
  nowMs: number = Date.now(),
): Promise<AuthSession> {
  const options = resolveAuthOptions(config);
  if (!shouldRefresh(options, session, nowMs)) return session;
  const now = Math.floor(nowMs / 1000);
  const { sessionId, ...rest } = session;
  const refreshed: AuthSession = {
    ...rest,
    v: 2,
    issuedAt: now,
    expiresAt: now + options.maxAge,
  };
  const cookie = await getSession<CookieData>(sessionOptions(config));
  if (!options.sessionStore) {
    await cookie.set(refreshed);
    return refreshed;
  }
  // Store-backed: without an id there is nothing to rewrite (a stateless cookie is not
  // honored in store mode anyway) — leave the session alone.
  if (!sessionId) return session;
  await options.sessionStore.create(sessionId, refreshed);
  await cookie.set({ sid: sessionId });
  return { ...refreshed, sessionId };
}

/**
 * Clear the auth session: delete the cookie and, when store-backed, the store record.
 *
 * @param config The app's auth config.
 */
export async function clearAuthSession(config: AuthConfig): Promise<void> {
  const options = resolveAuthOptions(config);
  const session = await getSession<CookieData>(sessionOptions(config));
  const sid = storeId(session.data);
  if (sid && options.sessionStore) await options.sessionStore.delete(sid);
  session.clear();
}
