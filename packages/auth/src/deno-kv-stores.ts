/**
 * Auth stores on Deno KV: {@linkcode denoKvSessionStore} (revocable sessions) and
 * {@linkcode denoKvRateLimitStore} (the limiters' failure counts), shared by every isolate and
 * region of a Deno Deploy app, or every process opening one KV database.
 *
 * ```ts
 * import { denextAuth, denoKvRateLimitStore, denoKvSessionStore } from "@denext/auth";
 * denextAuth({
 *   ...,
 *   sessionStore: denoKvSessionStore(),
 *   rateLimit: { store: denoKvRateLimitStore() },
 * });
 * ```
 *
 * Every read-modify-write is an atomic commit checked against the version it read, retried on
 * a conflict, so concurrent failures are all counted and a revoked session is never written
 * back. Keys carry KV's `expireIn`, so closed windows and expired sessions are reclaimed by KV
 * itself; reads also check the expiry, since KV deletes expired keys only eventually.
 *
 * @module
 */

import type { SessionStore } from "./session-store.ts";
import { sessionExpired } from "./session-store.ts";
import type { RateLimitStore, RateLimitWindow } from "./rate-limit.ts";
import type { AuthSession } from "./types.ts";
import {
  type DenoKvConnectionOptions,
  kvHandle,
  type KvKey,
  listAll,
  retryCommit,
} from "@denext/denext/auth-kit";

/** Options for {@linkcode denoKvSessionStore}. */
export type DenoKvSessionStoreOptions = DenoKvConnectionOptions;

/** Options for {@linkcode denoKvRateLimitStore}. */
export type DenoKvRateLimitStoreOptions = DenoKvConnectionOptions;

/** KV deletes in batches this size (a commit holds at most 1000 mutations). */
const DELETE_BATCH = 400;

/**
 * A durable, shared {@linkcode SessionStore} on Deno KV.
 *
 * @param options `kv` (an open `Deno.Kv`) or `path` (what to pass to `Deno.openKv`), and a key
 *   `prefix` (default `["denext", "session"]`).
 * @returns A store to pass as `denextAuth({ sessionStore })`; `close()` closes a database it
 *   opened.
 * @throws {DenoKvUnsupportedError} When it must open a database and `Deno.openKv` is missing.
 */
export function denoKvSessionStore(
  options: DenoKvSessionStoreOptions = {},
): SessionStore & { close(): Promise<void> } {
  const handle = kvHandle(options, "denoKvSessionStore");
  const p = options.prefix ?? ["denext", "session"];
  const sessionKey = (id: string): KvKey => [...p, "s", id];
  const userKey = (userId: string, id: string): KvKey => [...p, "u", userId, id];
  const ttl = (session: AuthSession) => ({ expireIn: session.expiresAt * 1000 - Date.now() });
  const live = (value: unknown) =>
    value && !sessionExpired(value as AuthSession) ? value as AuthSession : undefined;
  return {
    async create(id, session) {
      const kv = await handle.db();
      if (sessionExpired(session)) return void await kv.atomic().delete(sessionKey(id)).commit();
      await kv.atomic()
        .set(sessionKey(id), session, ttl(session))
        .set(userKey(session.user.id, id), true, ttl(session))
        .commit();
    },
    async update(id, session) {
      if (sessionExpired(session)) return false;
      const kv = await handle.db();
      return await retryCommit<boolean>(async () => {
        const current = await kv.get(sessionKey(id));
        const old = live(current.value);
        // Write-only-if-present: a revoked or expired session stays gone.
        if (!old) return { done: true, value: false };
        const op = kv.atomic().check({ key: sessionKey(id), versionstamp: current.versionstamp });
        if (old.user.id !== session.user.id) op.delete(userKey(old.user.id, id));
        op.set(sessionKey(id), session, ttl(session));
        op.set(userKey(session.user.id, id), true, ttl(session));
        return (await op.commit()).ok ? { done: true, value: true } : { done: false };
      }, "denoKvSessionStore");
    },
    async get(id) {
      return live((await (await handle.db()).get(sessionKey(id))).value);
    },
    async delete(id) {
      const kv = await handle.db();
      const current = await kv.get(sessionKey(id));
      const op = kv.atomic().delete(sessionKey(id));
      const old = current.value as AuthSession | null;
      if (old?.user?.id !== undefined) op.delete(userKey(old.user.id, id));
      await op.commit();
    },
    async deleteByUser(userId) {
      const kv = await handle.db();
      const ids = (await listAll(kv, { prefix: [...p, "u", userId] })).map((e) =>
        String(e.key.at(-1))
      );
      for (let first = 0; first < ids.length; first += DELETE_BATCH) {
        const op = kv.atomic();
        for (const id of ids.slice(first, first + DELETE_BATCH)) {
          op.delete(sessionKey(id)).delete(userKey(userId, id));
        }
        await op.commit();
      }
    },
    close: () => handle.close(),
  };
}

/**
 * A shared {@linkcode RateLimitStore} on Deno KV.
 *
 * @param options `kv` (an open `Deno.Kv`) or `path` (what to pass to `Deno.openKv`), and a key
 *   `prefix` (default `["denext", "ratelimit"]`).
 * @returns A store to pass as `denextAuth({ rateLimit: { store } })`; `close()` closes a
 *   database it opened.
 * @throws {DenoKvUnsupportedError} When it must open a database and `Deno.openKv` is missing.
 */
export function denoKvRateLimitStore(
  options: DenoKvRateLimitStoreOptions = {},
): RateLimitStore & { close(): Promise<void> } {
  const handle = kvHandle(options, "denoKvRateLimitStore");
  const p = options.prefix ?? ["denext", "ratelimit"];
  const keyOf = (key: string): KvKey => [...p, key];
  const open = (value: unknown, now: number): RateLimitWindow | undefined => {
    const w = value as RateLimitWindow | null;
    return w && w.resetAt > now ? { count: w.count, resetAt: w.resetAt } : undefined;
  };
  return {
    async get(key) {
      return open((await (await handle.db()).get(keyOf(key))).value, Date.now());
    },
    async increment(key, windowMs) {
      const kv = await handle.db();
      return await retryCommit<RateLimitWindow>(async () => {
        const current = await kv.get(keyOf(key));
        const now = Date.now();
        const was = open(current.value, now);
        const next = was
          ? { count: was.count + 1, resetAt: was.resetAt }
          : { count: 1, resetAt: now + windowMs };
        const ok = (await kv.atomic()
          .check({ key: keyOf(key), versionstamp: current.versionstamp })
          .set(keyOf(key), next, { expireIn: Math.max(1, next.resetAt - now) })
          .commit()).ok;
        return ok ? { done: true, value: next } : { done: false };
      }, "denoKvRateLimitStore");
    },
    async reset(key) {
      await (await handle.db()).atomic().delete(keyOf(key)).commit();
    },
    async decrement(key) {
      const kv = await handle.db();
      await retryCommit<void>(async () => {
        const current = await kv.get(keyOf(key));
        const now = Date.now();
        const was = open(current.value, now);
        if (!was || was.count <= 0) return { done: true, value: undefined };
        const ok = (await kv.atomic()
          .check({ key: keyOf(key), versionstamp: current.versionstamp })
          .set(keyOf(key), { ...was, count: was.count - 1 }, {
            expireIn: Math.max(1, was.resetAt - now),
          })
          .commit()).ok;
        return ok ? { done: true, value: undefined } : { done: false };
      }, "denoKvRateLimitStore");
    },
    close: () => handle.close(),
  };
}
