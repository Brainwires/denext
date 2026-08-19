// Session helpers built on denext's signed-cookie sessions (`getSession`). The
// cookie stores only a `userId`; the user row is loaded from SQLite per request.

import { getSession } from "denext/server";
import { getUser, type User } from "./db.ts";

/** What we keep in the signed session cookie. */
interface SessionData {
  userId: number;
}

/**
 * The session secret. In a real app this is a strong, rotated secret from the
 * environment; the fallback keeps the demo runnable with no setup.
 */
export function sessionSecret(): string {
  return Deno.env.get("SESSION_SECRET") ?? "dev-insecure-secret-change-me";
}

/** The current session handle (signed, HMAC-verified). */
export function session() {
  return getSession<SessionData>({ secret: sessionSecret() });
}

/** The logged-in user for this request, or `null`. */
export async function currentUser(): Promise<User | null> {
  const s = await session();
  if (!s.data) return null;
  return getUser(s.data.userId) ?? null;
}
