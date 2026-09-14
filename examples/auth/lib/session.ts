// The Server Actions' session gate. middleware.ts gates the PAGES, but every Server Action is
// its own endpoint — a form can be replayed after its session ended — so each one checks.

import { redirect } from "denext";
import { auth, type AuthSession } from "denext/server";

/**
 * The signed-in session, or a redirect to the login page (coming back to `returnTo`).
 *
 * @param returnTo The page to return to after signing in, if any.
 * @returns The complete session — a sign-in still owing its second factor reads as none.
 */
export async function signedIn(returnTo?: string): Promise<AuthSession> {
  const session = await auth();
  if (!session) {
    redirect(returnTo ? `/login?callbackUrl=${encodeURIComponent(returnTo)}` : "/login");
  }
  return session;
}
