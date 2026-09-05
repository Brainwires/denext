// Route gate: anything under /notes requires a signed-in session. The session is
// HMAC-verified here (not just "is a cookie present"), so a forged cookie can't
// slip past. Runs before routing; `getSession` works because the request context
// is already active.

import { type MiddlewareContext, next, redirectResponse } from "denext/server";
import { session } from "./lib/auth.ts";

export default async function middleware(
  _request: Request,
  ctx: MiddlewareContext,
) {
  const path = ctx.url.pathname;
  const gated = path === "/notes" || path.startsWith("/notes/");
  if (gated) {
    const s = await session();
    if (!s.data) {
      return redirectResponse(`/login?next=${encodeURIComponent(path)}`, 307);
    }
  }
  return next();
}

export const config = {
  matcher: "/:path*",
};
