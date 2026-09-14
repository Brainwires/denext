// A single-use, server-side slot: the "show this exactly once" half of the API-token page.
//
// `issueApiToken` returns the plaintext once and stores only its SHA-256, so the value has
// to survive precisely one hop — the Server Action that minted it → the page render that
// follows its redirect. It must NOT travel in the redirect URL: browsers keep URLs in
// history, send them as `Referer` and servers log them, and a URL is the classic way a
// one-time secret becomes a permanent one.
//
// A process-local Map is enough for one node (like the sqlite session store); a
// multi-replica deployment would put this in the shared store that already holds sessions.

import type { AuthSession } from "denext/server";

/** How long an unread value lingers before it is dropped (the redirect is immediate). */
const TTL_MS = 60_000;

const slots = new Map<string, { value: string; expires: number }>();

/**
 * The slot key for a session: the server-side session id when there is one, else the user
 * id — so one user's value can never be read by another's browser.
 *
 * @param session The signed-in session.
 * @returns The key to stash under / take from.
 */
export function onceKey(session: AuthSession): string {
  return session.sessionId ?? session.user.id;
}

/**
 * Put a value where exactly one later read can find it.
 *
 * @param key The slot key (see {@link onceKey}).
 * @param value The one-time value.
 */
export function stashOnce(key: string, value: string): void {
  slots.set(key, { value, expires: Date.now() + TTL_MS });
}

/**
 * Take the value out of a slot — it is gone afterwards, whether or not it was rendered.
 *
 * @param key The slot key (see {@link onceKey}).
 * @returns The stashed value, or `undefined` when there is none (or it expired).
 */
export function takeOnce(key: string): string | undefined {
  const slot = slots.get(key);
  slots.delete(key);
  return slot && slot.expires > Date.now() ? slot.value : undefined;
}
