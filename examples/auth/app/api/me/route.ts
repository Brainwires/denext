// A bearer-authenticated endpoint: no cookie, no session, no CSRF question — the caller
// presents `Authorization: Bearer tok_…` on every request.
//
//   curl -H "Authorization: Bearer tok_…" http://localhost:3000/api/me
//
// `requireBearer` verifies the token against the adapter (an indexed lookup on its hash —
// nothing secret is compared in-process), loads its user, and hands the handler
// `ctx.token` / `ctx.user` / `ctx.session`. Unknown, revoked and expired tokens are all the
// same 401. It also documents itself: an endpoint built with it is marked secured in the
// `@denext/openapi` document with nothing written here.

import { createApi, requireBearer } from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";

/** Endpoints that require a valid API token. Add `{ scope: "me:read" }` to require a scope. */
const authed = createApi().use(requireBearer(authConfig));

export const GET = authed.define({
  summary: "The profile of the user whose API token was presented.",
}, ({ ctx }) => ({
  id: ctx.user.id,
  email: ctx.user.email,
  name: ctx.user.name,
  roles: ctx.user.roles ?? [],
  token: { id: ctx.token.id, name: ctx.token.name, scopes: ctx.token.scopes ?? [] },
}));
