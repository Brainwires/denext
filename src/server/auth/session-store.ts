/**
 * Server-side auth sessions (opt-in): a pluggable {@linkcode SessionStore} that makes
 * sessions **revocable**. By default denext sessions are stateless — the signed cookie
 * carries the whole `{ user, provider, expiresAt }` payload, which is what makes
 * zero-config edge/serverless/multi-replica deploys work, but it also means a session
 * can't be invalidated before it expires (a stolen cookie or a password change can't
 * kick a live session). Pass `sessionStore` to `denextAuth` and the cookie carries only
 * a random session id; the payload lives in the store, so `revokeSession` /
 * `revokeAllSessions` end sessions immediately.
 *
 * **Multi-replica:** the in-memory store is per-process — a session created on one
 * replica is invisible to the others. Point every replica at one shared store (the
 * `node:sqlite` file on a single node, or your own `SessionStore` over Redis/Postgres).
 *
 * @module
 */

import type { AuthSession } from "./types.ts";

/**
 * Where store-backed sessions live. Every method may be sync or async; `get` must
 * return only an **unexpired** session (treat `expiresAt` in the past as a miss).
 */
export interface SessionStore {
  /** Persist `session` under the (random, unguessable) `id`. */
  create(id: string, session: AuthSession): void | Promise<void>;
  /**
   * Optional, but **required for sliding expiry** (`session.updateAge`): rewrite an
   * EXISTING record in place — write-only-if-present. It must NOT create a row: the
   * whole point is that a session revoked between the read and the refresh stays
   * revoked instead of being resurrected with a fresh lifetime by an upsert.
   *
   * A store that doesn't implement it simply never slides its sessions forward
   * ({@link ../auth/session.ts | refreshIfStale} returns the session untouched and
   * warns once), which is safe — the session still expires on its original schedule.
   *
   * @param id The session id to rewrite.
   * @param session The refreshed payload.
   * @returns `true` when a live row was rewritten; `false` when `id` is unknown,
   * revoked or expired (nothing was written).
   */
  update?(id: string, session: AuthSession): boolean | Promise<boolean>;
  /** The live session for `id`, or `undefined` when absent, revoked, or expired. */
  get(id: string): AuthSession | undefined | Promise<AuthSession | undefined>;
  /** Revoke one session (a no-op for an unknown id). */
  delete(id: string): void | Promise<void>;
  /** Revoke every session belonging to `userId` ("sign out everywhere"). */
  deleteByUser(userId: string): void | Promise<void>;
  /** Optional: release resources (a DB handle) when the server drains. */
  close?(): void | Promise<void>;
}

/** Options for {@linkcode inMemorySessionStore}. */
export interface InMemorySessionStoreOptions {
  /** Max live sessions before the oldest are evicted (FIFO). Default 10000. */
  maxEntries?: number;
  /** Min ms between proactive sweeps of expired sessions (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL = 30_000;

/** Whether `session` has passed its `expiresAt` (epoch seconds). */
export function sessionExpired(session: AuthSession, nowMs = Date.now()): boolean {
  return typeof session.expiresAt !== "number" || session.expiresAt * 1000 <= nowMs;
}

/**
 * The per-process, in-memory {@linkcode SessionStore}. Bounded: past `maxEntries` expired
 * sessions are dropped first, then the least recently used live ones; expired ones are
 * also swept on a throttled schedule.
 * Sessions don't survive a restart and aren't shared across replicas — use
 * {@link ../auth/sqlite-session-store.ts | sqliteSessionStore} (or your own) for that.
 *
 * @param options Size cap + sweep interval.
 * @returns A store to pass as `denextAuth({ sessionStore })`.
 */
export function inMemorySessionStore(options: InMemorySessionStoreOptions = {}): SessionStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
  const sessions = new Map<string, AuthSession>();
  let lastSweep = 0;

  const maybeSweep = (): void => {
    const now = Date.now();
    if (now - lastSweep < sweepInterval) return;
    lastSweep = now;
    for (const [id, s] of sessions) if (sessionExpired(s, now)) sessions.delete(id);
  };

  return {
    create(id, session) {
      maybeSweep();
      sessions.delete(id);
      sessions.set(id, session);
      if (sessions.size > maxEntries) {
        // Drop expired sessions first; only then the least recently used live ones.
        for (const [k, s] of sessions) if (sessionExpired(s)) sessions.delete(k);
        while (sessions.size > maxEntries) sessions.delete(sessions.keys().next().value as string);
      }
    },
    update(id, session) {
      // Write-only-if-present: a record deleted by `revokeSession`/`revokeAllSessions`
      // while this request was in flight must NOT come back (see the interface doc).
      const current = sessions.get(id);
      if (!current || sessionExpired(current)) return false;
      sessions.delete(id); // re-insert: the rewritten row is the youngest, like `create`
      sessions.set(id, session);
      return true;
    },
    get(id) {
      const s = sessions.get(id);
      if (!s) return undefined;
      if (sessionExpired(s)) {
        sessions.delete(id);
        return undefined;
      }
      sessions.delete(id); // re-insert: eviction order is least-recently-USED, not created
      sessions.set(id, s);
      return s;
    },
    delete: (id) => void sessions.delete(id),
    deleteByUser(userId) {
      for (const [id, s] of sessions) if (s.user.id === userId) sessions.delete(id);
    },
  };
}
