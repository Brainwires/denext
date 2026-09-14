/**
 * The session-shaped endpoints: `GET {basePath}/session`, `GET {basePath}/providers`
 * and `POST {basePath}/signout`. None of them talk to a provider — they read or clear
 * the app's own session cookie.
 *
 * @module
 */

import {
  afterSignOut,
  type AuthRouteContext,
  isSameOrigin,
  json,
  redirect,
  wantsJson,
} from "./routes-shared.ts";
import { clearAuthSession, readAuthSession } from "./session.ts";

/**
 * `GET {basePath}/session` — the client's view of the session: the user and the expiry,
 * or nulls when signed out. `no-store`, so no cache ever holds one user's answer.
 *
 * @param ctx The route context.
 * @returns The JSON session response.
 */
export async function handleSession(ctx: AuthRouteContext): Promise<Response> {
  const session = await readAuthSession(ctx.config);
  return json({ user: session?.user ?? null, expires: session?.expiresAt ?? null });
}

/**
 * `GET {basePath}/providers` — the configured providers' ids and types, so a sign-in page
 * can render its buttons. Never exposes client ids, secrets, or endpoints.
 *
 * @param ctx The route context.
 * @returns The JSON provider list.
 */
export function handleProviders(ctx: AuthRouteContext): Response {
  return json(ctx.config.providers.map((p) => ({ id: p.id, type: p.type })));
}

/**
 * `POST {basePath}/signout` — clears the session cookie (and the store record, when
 * server-side sessions are on). Same-origin only: a cross-origin POST is a CSRF logout.
 *
 * @param ctx The route context.
 * @returns A JSON `{ ok }` for an API client, otherwise a redirect.
 */
export async function handleSignout(ctx: AuthRouteContext): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  await clearAuthSession(ctx.config);
  const back = afterSignOut(ctx.config, ctx.url.searchParams.get("callbackUrl"));
  return wantsJson(ctx.request) ? json({ ok: true }) : redirect(back);
}
