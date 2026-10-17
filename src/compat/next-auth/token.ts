/**
 * The sealed Auth.js token a request's denext session carries (JWT strategy) — what
 * `next-auth/jwt`'s `getToken()` and `next-auth/middleware` open.
 *
 * @module
 */

import { readAuthSession } from "../../server/auth/session.ts";
import type { ActiveNextAuth } from "./state.ts";

/**
 * The sealed token the current request's session carries under `active`, or `null` (signed
 * out, a database session, or a session still owing a second factor).
 *
 * @param active The instance, or `null`.
 * @returns The sealed token, or `null`.
 */
export async function sealedSessionToken(active: ActiveNextAuth | null): Promise<string | null> {
  if (!active) return null;
  const session = await readAuthSession(active.denext);
  const sealed = (session as { authjs?: unknown } | null)?.authjs;
  return typeof sealed === "string" && !session?.mfaPending ? sealed : null;
}
