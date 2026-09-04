/**
 * Auth session issuance/reads on top of denext's signed-cookie sessions
 * ({@link ../session.ts | getSession}). The payload is signed (tamper-evident) but
 * **readable** — it stores only a non-sensitive {@link AuthUser} + provider +
 * expiry, never tokens or secrets.
 *
 * Two modes, chosen by `AuthConfig.sessionStore`:
 * - **stateless** (default): the cookie carries the whole {@link AuthSession};
 * - **store-backed**: the cookie carries only `{ sid }` — a random id — and the
 *   payload lives in the {@link SessionStore}, so a session can be revoked.
 *
 * @module
 */

import { getSession, type SessionOptions } from "../session.ts";
import { randomToken } from "./oauth.ts";
import { sessionExpired, type SessionStore } from "./session-store.ts";
import type { AuthConfig, AuthSession, AuthUser } from "./types.ts";

/** The auth session cookie name (origin-bound via the `__Host-` prefix). */
const AUTH_COOKIE = "denext_auth";

/** Default session lifetime: 7 days. */
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7;

/** What the signed cookie carries: the payload (stateless) or a store id. */
type CookieData = AuthSession | { sid: string };

function sessionOptions(config: AuthConfig): SessionOptions {
  return {
    secret: config.secret,
    cookieName: AUTH_COOKIE,
    hostPrefix: true, // __Host- origin-locks the cookie (Secure + Path=/ + no Domain)
    maxAge: config.maxAge ?? DEFAULT_MAX_AGE,
  };
}

/** The store id in a cookie payload, or `undefined` for a stateless payload. */
function storeId(data: CookieData | null): string | undefined {
  return data && "sid" in data && typeof data.sid === "string" ? data.sid : undefined;
}

/** `session` when it is a well-formed, unexpired payload — else null. */
function liveSession(session: AuthSession | undefined): AuthSession | null {
  if (!session || !session.user) return null;
  return sessionExpired(session) ? null : session;
}

/** Resolve the cookie data to a session: a store lookup, or the stateless payload. */
async function resolveSession(
  data: CookieData | null,
  store: SessionStore | undefined,
): Promise<AuthSession | null> {
  if (!data) return null;
  if (!store) return "sid" in data ? null : liveSession(data);
  const sid = storeId(data);
  if (!sid) return null; // a stateless cookie is not honored once a store is configured
  const stored = liveSession(await store.get(sid));
  return stored ? { ...stored, sessionId: sid } : null;
}

/** Read the current auth session, or `null` when absent/expired/invalid/revoked. */
export async function readAuthSession(config: AuthConfig): Promise<AuthSession | null> {
  const session = await getSession<CookieData>(sessionOptions(config));
  return resolveSession(session.data, config.sessionStore);
}

/** Issue (sign + set) a session for `user` from `provider`, applying the session callback. */
export async function issueAuthSession(
  config: AuthConfig,
  user: AuthUser,
  provider: string,
): Promise<AuthSession> {
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
  let payload: AuthSession = {
    user,
    provider,
    expiresAt: Math.floor(Date.now() / 1000) + maxAge,
  };
  if (config.callbacks?.session) payload = await config.callbacks.session(payload);
  const session = await getSession<CookieData>(sessionOptions(config));
  if (!config.sessionStore) {
    await session.set(payload);
    return payload;
  }
  // Store-backed: a fresh random id per login (no fixation), the payload server-side.
  const sid = randomToken();
  await config.sessionStore.create(sid, payload);
  await session.set({ sid });
  return { ...payload, sessionId: sid };
}

/** Clear the auth session: delete the cookie and, when store-backed, the store record. */
export async function clearAuthSession(config: AuthConfig): Promise<void> {
  const session = await getSession<CookieData>(sessionOptions(config));
  const sid = storeId(session.data);
  if (sid && config.sessionStore) await config.sessionStore.delete(sid);
  session.clear();
}
