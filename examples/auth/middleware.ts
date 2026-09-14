// Route gate. `requireAuth` reads (and verifies) the auth cookie — with database-backed
// sessions a revoked session is refused here even though the browser still holds its
// cookie — and redirects to /login with a callbackUrl back to the requested page.
//
// /admin additionally requires the `admin` ROLE (`AuthUser.roles`, stored on the adapter
// user): a signed-in account without it is redirected to /login?error=forbidden. Richer
// rules than "any of these roles" go in `callbacks.authorized`, which also sees the request.
//
// A request that passes also slides the session forward (`session.updateAge`): middleware
// owns its response, so the re-issued cookie rides along.

import { requireAuth } from "denext/server";

/** The admin area — everything under it needs the `admin` role. */
const ADMIN = "/admin";

export async function middleware(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const admin = pathname === ADMIN || pathname.startsWith(`${ADMIN}/`);
  return await requireAuth(request, {
    signInPath: "/login",
    role: admin ? "admin" : undefined,
  });
}

export const config = {
  // Both the bare path and everything under it (`:path*` alone needs a trailing segment).
  // /api/me is deliberately absent: it authenticates with a bearer token, not a cookie.
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    "/account",
    "/account/:path*",
    "/admin",
    "/admin/:path*",
  ],
};
