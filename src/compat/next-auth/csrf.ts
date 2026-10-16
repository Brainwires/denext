/**
 * Auth.js's CSRF token on denext: a double-submit token whose cookie is denext's signed,
 * `httpOnly`, `SameSite=Lax` session cookie (`__Host-authjs.csrf-token`, unprefixed over plain http as denextAuth's
 * cookies are). `GET
 * {basePath}/csrf` answers the token; every state-changing POST the shim fronts must send it
 * back as `csrfToken` — on top of denext's own same-origin check, never instead of it.
 *
 * @module
 */

import { constantTimeEqualHex } from "../../server/auth/hash.ts";
import { randomToken } from "../../server/auth/oauth.ts";
import { plainHttpCookies } from "../../server/auth/options.ts";
import { getSession } from "../../server/session.ts";
import type { ActiveNextAuth } from "./state.ts";

/** The cookie name (before denext's `__Host-` prefix). */
const CSRF_COOKIE = "authjs.csrf-token";

/** The signed CSRF cookie of this request. */
function csrfCookie(active: ActiveNextAuth) {
  return getSession<{ t: string }>({
    secret: active.secret,
    cookieName: CSRF_COOKIE,
    hostPrefix: !plainHttpCookies(active.denext),
    sameSite: "Lax",
    maxAge: active.maxAge,
  });
}

/**
 * This browser's CSRF token, minting (and setting the cookie for) one on first use.
 *
 * @param active The instance.
 * @returns The token.
 */
export async function csrfToken(active: ActiveNextAuth): Promise<string> {
  const cookie = await csrfCookie(active);
  const existing = cookie.data?.t;
  if (typeof existing === "string" && existing) return existing;
  const token = randomToken(32);
  await cookie.set({ t: token });
  return token;
}

/**
 * Whether `submitted` is this browser's CSRF token (constant-time).
 *
 * @param active The instance.
 * @param submitted The `csrfToken` the request carried.
 * @returns `true` only for the token in the signed cookie.
 */
export async function csrfTokenValid(active: ActiveNextAuth, submitted: unknown): Promise<boolean> {
  const cookie = await csrfCookie(active);
  const expected = cookie.data?.t;
  if (typeof expected !== "string" || !expected || typeof submitted !== "string") return false;
  return constantTimeEqualHex(expected, submitted);
}
