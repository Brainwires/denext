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
import { emitAuthEvent } from "./events.ts";
import { clearAuthSession, readAuthSession, refreshIfStale } from "./session.ts";

/**
 * `GET {basePath}/session` — the client's view of the session: the user and the expiry,
 * or nulls when signed out. `no-store`, so no cache ever holds one user's answer.
 *
 * This is the canonical sliding-expiry path: it owns its response, so a session aged past
 * `session.updateAge` is re-issued here ({@link refreshIfStale}) and the client's polling
 * keeps an active user signed in. A session still owing a second factor answers
 * `{ user: null, mfa: "required" }` — the user is never exposed before MFA completes, but
 * the client can tell "finish your second factor" from "signed out".
 *
 * @param ctx The route context.
 * @returns The JSON session response.
 */
export async function handleSession(ctx: AuthRouteContext): Promise<Response> {
  const session = await readAuthSession(ctx.config);
  if (!session) return json({ user: null, expires: null });
  if (session.mfaPending) return json({ user: null, expires: null, mfa: "required" });
  const live = await refreshIfStale(ctx.config, session);
  return json({ user: live.user, expires: live.expiresAt });
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
 * Fires the `signOut` event with the session that ended (`null` when there was none) —
 * an audit hook sees the sign-out even though the cookie is already gone.
 *
 * @param ctx The route context.
 * @returns A JSON `{ ok }` for an API client, otherwise a redirect.
 */
export async function handleSignout(ctx: AuthRouteContext): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  // Read before clearing: the event carries the session that ended, pending ones included.
  const ended = await readAuthSession(ctx.config);
  await clearAuthSession(ctx.config);
  await emitAuthEvent(ctx.options, "signOut", { session: ended });
  const back = afterSignOut(ctx.config, ctx.url.searchParams.get("callbackUrl"));
  return wantsJson(ctx.request) ? json({ ok: true }) : redirect(back);
}
