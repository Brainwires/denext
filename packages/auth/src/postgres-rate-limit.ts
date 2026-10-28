/**
 * A {@linkcode RateLimitStore} on Postgres: the auth limiters' failure counts shared by every
 * replica, so a lockout on one instance holds on all of them.
 *
 * ```ts
 * import { denextAuth, postgresRateLimitStore } from "@denext/auth";
 * denextAuth({ ..., rateLimit: { store: postgresRateLimitStore({ url: Deno.env.get("DATABASE_URL") }) } });
 * ```
 *
 * Each `increment` is one atomic upsert (open a window, or count into the open one, or start
 * over once it closed), so concurrent failures on many replicas are all counted. Rows live in
 * `auth_rate_limits`, created by the auth migrations; closed windows are swept, throttled.
 * Unlike the in-memory store there is no key cap to evict under: the table is on disk.
 *
 * @module
 */

import type { RateLimitStore, RateLimitWindow } from "./rate-limit.ts";
import { type AuthDb, authDb, type PostgresAuthStoreOptions } from "./postgres-schema.ts";

/** Options for {@linkcode postgresRateLimitStore}. */
export interface PostgresRateLimitStoreOptions extends PostgresAuthStoreOptions {
  /** Min ms between sweeps of closed windows (default 60000; `0` = every increment). */
  sweepIntervalMs?: number;
}

const SWEEP_INTERVAL = 60_000;

/**
 * A shared {@linkcode RateLimitStore} on Postgres.
 *
 * @param options `sql` (a client) or `url` (opened with `Deno.SQL`), an optional `schema`,
 *   `migrate`, and the sweep interval.
 * @returns A store to pass as `denextAuth({ rateLimit: { store } })`; `close()` closes a client
 *   it opened.
 * @throws {PostgresUnsupportedError} For `url` on a Deno without `Deno.SQL` (pass `sql`).
 */
export function postgresRateLimitStore(
  options: PostgresRateLimitStoreOptions,
): RateLimitStore & { close(): Promise<void> } {
  const handle = authDb(options, "postgresRateLimitStore");
  return {
    ...pgRateLimitStore(handle, options.sweepIntervalMs),
    close: () => handle.close(),
  };
}

/**
 * The store over an auth handle (`postgresAuthAdapter`'s `rateLimits` shares the adapter's).
 *
 * @param handle The auth tables' handle.
 * @param sweepInterval Min ms between sweeps of closed windows.
 * @returns The store.
 */
export function pgRateLimitStore(
  handle: AuthDb,
  sweepInterval: number = SWEEP_INTERVAL,
): RateLimitStore {
  const table = handle.table("auth_rate_limits");
  let lastSweep = 0;
  // `int8` arrives as a string (or a bigint) from most drivers.
  const window = (row: { hits: unknown; reset_at: unknown }): RateLimitWindow => ({
    count: Number(row.hits),
    resetAt: Number(row.reset_at),
  });
  return {
    async get(key) {
      const [row] = await (await handle.ready()).unsafe<{ hits: unknown; reset_at: unknown }>(
        `SELECT hits, reset_at FROM ${table} WHERE key = $1 AND reset_at > $2`,
        [key, Date.now()],
      );
      return row ? window(row) : undefined;
    },
    async increment(key, windowMs) {
      const db = await handle.ready();
      const now = Date.now();
      // One statement: a closed window starts over at 1, an open one counts up.
      const [row] = await db.unsafe<{ hits: unknown; reset_at: unknown }>(
        `INSERT INTO ${table} AS r (key, hits, reset_at) VALUES ($1, 1, $2) ` +
          "ON CONFLICT (key) DO UPDATE SET " +
          "hits = CASE WHEN r.reset_at <= $3 THEN 1 ELSE r.hits + 1 END, " +
          "reset_at = CASE WHEN r.reset_at <= $3 THEN EXCLUDED.reset_at ELSE r.reset_at END " +
          "RETURNING hits, reset_at",
        [key, now + windowMs, now],
      );
      if (now - lastSweep >= sweepInterval) {
        lastSweep = now;
        await db.unsafe(`DELETE FROM ${table} WHERE reset_at <= $1`, [now]);
      }
      return window(row);
    },
    async reset(key) {
      await (await handle.ready()).unsafe(`DELETE FROM ${table} WHERE key = $1`, [key]);
    },
    async decrement(key) {
      await (await handle.ready()).unsafe(
        `UPDATE ${table} SET hits = hits - 1 WHERE key = $1 AND hits > 0 AND reset_at > $2`,
        [key, Date.now()],
      );
    },
  };
}
