/**
 * The SAML origin of denextAuth's own store-backed sessions, kept for IdP-initiated Single
 * Logout: a session a `saml()` provider started is recorded through the adapter's SSO session
 * group (`createSsoSession` / `listSsoSessions`, the table `/auth/v1` keeps its SAML sessions
 * in), its id prefixed so the two kinds never mix. A LogoutRequest then ends exactly the
 * sessions its NameID (and SessionIndex) started.
 *
 * @module
 */

import type { AuthAdapter } from "./adapter.ts";
import type { ResolvedAuthOptions } from "./options.ts";
import type { AuthSession } from "./types.ts";

/** Marks a record as a denextAuth cookie session (`auth:<sid>`), not an `/auth/v1` family. */
export const COOKIE_SESSION_PREFIX = "auth:";

/** The adapter narrowed to the SSO session pair, or `null` when it keeps none. */
export function samlSessionStoreOf(
  adapter: AuthAdapter | undefined,
): Required<Pick<AuthAdapter, "createSsoSession" | "listSsoSessions">> | null {
  return typeof adapter?.createSsoSession === "function" &&
      typeof adapter.listSsoSessions === "function"
    ? adapter as Required<Pick<AuthAdapter, "createSsoSession" | "listSsoSessions">>
    : null;
}

/**
 * Record a store-backed session a SAML sign-in started (a no-op for any other session, or an
 * adapter without the SSO session group).
 *
 * @param options The resolved auth options.
 * @param session The session payload just stored.
 * @param sid Its session-store id.
 */
export async function recordSamlSession(
  options: ResolvedAuthOptions,
  session: AuthSession,
  sid: string,
): Promise<void> {
  const store = samlSessionStoreOf(options.adapter);
  if (!session.saml || !store) return;
  const signedIn = session.authTime ?? Math.floor(Date.now() / 1000);
  await store.createSsoSession({
    sessionId: COOKIE_SESSION_PREFIX + sid,
    providerId: session.provider,
    nameId: session.saml.nameId,
    ...(session.saml.sessionIndex !== undefined && { sessionIndex: session.saml.sessionIndex }),
    userId: session.user.id,
    expiresAt: signedIn + options.maxLifetime,
  });
}
