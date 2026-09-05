// Root middleware — runs before routing on every request.
// (Named `middleware.ts`; denext also accepts `proxy.ts`.)

import { type MiddlewareContext, next, redirectResponse } from "denext/server";

export default function middleware(_request: Request, ctx: MiddlewareContext) {
  // Redirect a legacy path to its new home.
  if (ctx.url.pathname === "/old-about") {
    return redirectResponse("/about", 308);
  }
  // Otherwise continue, tagging the response with a header.
  return next({ headers: { "x-powered-by": "denext" } });
}

export const config = {
  // Run on everything except static assets and framework internals.
  matcher: "/:path*",
};
