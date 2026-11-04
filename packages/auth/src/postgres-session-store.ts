/**
 * A {@linkcode SessionStore} on Postgres, so revocable auth sessions are shared by every
 * replica and survive restarts:
 *
 * ```ts
 * import { denextAuth, postgresSessionStore } from "@denext/auth";
 * denextAuth({ ..., sessionStore: postgresSessionStore({ url: Deno.env.get("DATABASE_URL") }) });
 * ```
 *
 * Rows live in `auth_sessions`, created by the auth migrations (the same ones
 * `postgresAuthAdapter` applies — an adapter's `sessions` is this store over its own client).
 * Expired rows are reclaimed by a throttled sweep on writes.
 *
 * @module
 */

import type { SessionStore } from "./session-store.ts";
import type { AuthSession } from "./types.ts";
import { type AuthDb, authDb, type PostgresAuthStoreOptions } from "./postgres-schema.ts";

/** Options for {@linkcode postgresSessionStore}. */
export interface PostgresSessionStoreOptions extends PostgresAuthStoreOptions {
  /** Min ms between proactive expired-row sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
}

const SWEEP_INTERVAL = 30_000;

/** Epoch seconds now. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * The store over a shared handle — what `postgresAuthAdapter` exposes as `sessions`.
 *
 * @param handle The migrated client.
 * @param sweepInterval Min ms between expired-row sweeps.
 * @returns The store; its `close()` closes the handle (idempotent).
 */
export function pgSessionStore(handle: AuthDb, sweepInterval = SWEEP_INTERVAL): SessionStore {
  const table = handle.table("auth_sessions");
  let lastSweep = 0;
  return {
    async create(id, session) {
      const db = await handle.ready();
      await db.unsafe(
        `INSERT INTO ${table} (id, user_id, payload, expires_at) VALUES ($1, $2, $3, $4) ` +
          "ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, " +
          "payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at",
        [id, session.user.id, JSON.stringify(session), session.expiresAt],
      );
      const at = Date.now();
      if (at - lastSweep < sweepInterval) return;
      lastSweep = at;
      await db.unsafe(`DELETE FROM ${table} WHERE expires_at <= $1`, [nowSeconds()]);
    },
    async update(id, session) {
      // `UPDATE … WHERE id` is the point: a row revoked while this request was in flight is
      // not there, so nothing is written and a revoked session is never resurrected.
      const changed = await (await handle.ready()).unsafe(
        `UPDATE ${table} SET user_id = $1, payload = $2, expires_at = $3 ` +
          "WHERE id = $4 AND expires_at > $5 RETURNING id",
        [session.user.id, JSON.stringify(session), session.expiresAt, id, nowSeconds()],
      );
      return changed.length === 1;
    },
    async get(id) {
      const [row] = await (await handle.ready()).unsafe<{ payload: string }>(
        `SELECT payload FROM ${table} WHERE id = $1 AND expires_at > $2`,
        [id, nowSeconds()],
      );
      return row ? JSON.parse(row.payload) as AuthSession : undefined;
    },
    async delete(id) {
      await (await handle.ready()).unsafe(`DELETE FROM ${table} WHERE id = $1`, [id]);
    },
    async deleteByUser(userId) {
      await (await handle.ready()).unsafe(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    },
    close: () => handle.close(),
  };
}

/**
 * A durable, shared {@linkcode SessionStore} on Postgres.
 *
 * @param options `sql` (a client) or `url` (opened with `Deno.SQL`), an optional `schema`,
 *   `migrate`, and the sweep interval.
 * @returns A store to pass as `denextAuth({ sessionStore })`.
 * @throws {PostgresUnsupportedError} For `url` on a Deno without `Deno.SQL` (pass `sql`).
 */
export function postgresSessionStore(options: PostgresSessionStoreOptions): SessionStore {
  return pgSessionStore(authDb(options, "postgresSessionStore"), options.sweepIntervalMs);
}
