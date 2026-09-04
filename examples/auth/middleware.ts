// Route gate: /dashboard requires a signed-in session. `requireAuth` reads (and
// verifies) the auth cookie — with the sqlite session store, a revoked session is
// refused here even though the browser still holds its cookie — and redirects to
// /login with a callbackUrl back to the requested page.

import { requireAuth } from "denext/server";

export async function middleware(request: Request): Promise<Response | null> {
  return await requireAuth(request, { signInPath: "/login" });
}

export const config = {
  // Both the bare path and everything under it (`:path*` alone needs a trailing segment).
  matcher: ["/dashboard", "/dashboard/:path*"],
};
