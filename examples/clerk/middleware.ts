// Clerk's middleware, exactly as in Clerk's Next.js quickstart: it authenticates every matched
// request (the session cookie on the web, an `Authorization: Bearer` session token from the
// desktop and mobile shells) and `auth.protect()` keeps signed-out visitors off the protected
// routes. Without keys (a fresh clone) it is a pass-through and the app shows its setup screen.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkJwtKey, hasServerKeys } from "./lib/clerk-env.ts";

// `/api/me` checks the session itself (and answers 401); a protected route would get a 404.
const isProtectedRoute = createRouteMatcher(["/protected(.*)"]);

export default hasServerKeys()
  ? clerkMiddleware(async (auth, req) => {
    if (isProtectedRoute(req)) await auth.protect();
  }, { jwtKey: clerkJwtKey() })
  : () => undefined;

export const config = {
  matcher: [
    // Skip framework internals and static files, unless found in search params.
    "/((?!_next|_denext|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
