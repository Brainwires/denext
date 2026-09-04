/**
 * Auth session issuance/reads on top of denext's signed-cookie sessions
 * ({@link ../session.ts | getSession}). The payload is signed (tamper-evident) but
 * **readable** — it stores only a non-sensitive {@link AuthUser} + provider +
 * expiry, never tokens or secrets.
 *
 * @module
 */

import { getSession, type SessionOptions } from "../session.ts";
import type { AuthConfig, AuthSession, AuthUser } from "./types.ts";

/** The auth session cookie name (origin-bound via the `__Host-` prefix). */
const AUTH_COOKIE = "denext_auth";

/** Default session lifetime: 7 days. */
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7;

function sessionOptions(config: AuthConfig): SessionOptions {
  return {
    secret: config.secret,
    cookieName: AUTH_COOKIE,
    hostPrefix: true, // __Host- origin-locks the cookie (Secure + Path=/ + no Domain)
    maxAge: config.maxAge ?? DEFAULT_MAX_AGE,
  };
}

/** Read the current auth session, or `null` when absent/expired/invalid. */
export async function readAuthSession(config: AuthConfig): Promise<AuthSession | null> {
  const session = await getSession<AuthSession>(sessionOptions(config));
  const data = session.data;
  if (!data || !data.user) return null;
  if (typeof data.expiresAt === "number" && data.expiresAt * 1000 <= Date.now()) return null;
  return data;
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
  const session = await getSession<AuthSession>(sessionOptions(config));
  await session.set(payload);
  return payload;
}

/** Clear the auth session (delete the cookie). */
export async function clearAuthSession(config: AuthConfig): Promise<void> {
  const session = await getSession<AuthSession>(sessionOptions(config));
  session.clear();
}
