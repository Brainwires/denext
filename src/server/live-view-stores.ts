/**
 * Shared {@linkcode LiveViewStore}s, so a parked live view resumes on any replica:
 *
 * ```ts
 * // instrumentation.ts
 * import { postgresLiveViewStore, setLiveViewStore } from "denext/server";
 * setLiveViewStore(postgresLiveViewStore({ url: Deno.env.get("DATABASE_URL") }));
 * ```
 *
 * Redis keeps each snapshot as one key that expires on its own (`SET … PX`, taken with
 * `GETDEL`, Redis 6.2+ / Valkey). Postgres keeps them in `live_view_snapshots`, created by a
 * migration (recorded in `live_view_migrations`) on first use; a take is `DELETE … RETURNING`, so
 * two replicas never both resume one view, and expired rows are swept on a throttle. The values
 * are sealed by the hub before they reach either store.
 *
 * @module
 */

import type { LiveViewStore } from "./live-view-store.ts";
import { type RedisConnectionOptions, resolveRedis } from "./redis.ts";
import {
  type PostgresConnectionOptions,
  resolveConnection,
  schemaPrefix,
  type SqlClient,
  toNumber,
} from "./postgres.ts";
import type { Migration } from "./postgres-migrate.ts";
import { bootMigrate, registerBootCheck, registerFrameworkMigrations } from "./postgres-boot.ts";
import { inRootContext } from "./root-context.ts";

/** Options for {@linkcode redisLiveViewStore}. */
export type RedisLiveViewStoreOptions = RedisConnectionOptions;

/**
 * A {@linkcode LiveViewStore} on Redis (6.2+, or Valkey), shared by every replica.
 *
 * @param options `client` (a `redisClient`) or `url`, and a key `prefix` (default
 *   `denext:liveview:`).
 * @returns A store for {@linkcode setLiveViewStore}; its `close()` closes a client it opened.
 * @throws {TypeError} When both `client` and `url` are given, or the URL is not a Redis URL.
 */
export function redisLiveViewStore(
  options: RedisLiveViewStoreOptions = {},
): LiveViewStore & { close(): Promise<void> } {
  const { client: redis, owned } = resolveRedis(options, "redisLiveViewStore");
  const key = (id: string) => `${options.prefix ?? "denext:liveview:"}${id}`;
  return {
    async set(id, sealed, ttlSeconds) {
      await redis.command("SET", key(id), sealed, "PX", Math.max(1, Math.round(ttlSeconds * 1000)));
    },
    async take(id) {
      const value = await redis.command("GETDEL", key(id));
      return typeof value === "string" ? value : null;
    },
    async delete(id) {
      await redis.command("DEL", key(id));
    },
    async close() {
      if (owned) await redis.close();
    },
  };
}

/** Options for {@linkcode postgresLiveViewStore}. */
export interface PostgresLiveViewStoreOptions extends PostgresConnectionOptions {
  /** Apply the table's migration on first use (default `true`). */
  migrate?: boolean;
  /** Min ms between expired-row sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
}

const FEATURE = "postgresLiveViewStore";
const MIGRATIONS_TABLE = "live_view_migrations";

function snapshotMigrations(p: string): Migration[] {
  return [{
    name: "0001_live_view_snapshots",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}live_view_snapshots (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS live_view_snapshots_expires ON ${p}live_view_snapshots (expires_at);
`,
  }];
}

/**
 * A {@linkcode LiveViewStore} on Postgres, shared by every replica.
 *
 * @param options `sql` (a client) or `url` (opened with `Deno.SQL`), an optional `schema`,
 *   `migrate`, and the sweep interval.
 * @returns A store for {@linkcode setLiveViewStore}; its `close()` closes a client it opened.
 * @throws {TypeError} When neither (or both) of `sql` and `url` is given.
 * @throws {PostgresUnsupportedError} For `url` on a Deno without `Deno.SQL` (pass `sql`).
 */
export function postgresLiveViewStore(
  options: PostgresLiveViewStoreOptions,
): LiveViewStore & { close(): Promise<void> } {
  const prefix = schemaPrefix(options.schema, FEATURE);
  const { sql, owned } = resolveConnection(options, FEATURE);
  const table = `${prefix}live_view_snapshots`;
  const sweepInterval = options.sweepIntervalMs ?? 30_000;
  const migrationSet = {
    feature: FEATURE,
    migrations: snapshotMigrations(prefix),
    table: MIGRATIONS_TABLE,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  };
  registerFrameworkMigrations(`live-views:${options.schema ?? ""}`, migrationSet);
  let migrated: Promise<void> | undefined;
  let lastSweep = 0;
  let closed = false;
  const db = async (): Promise<SqlClient> => {
    if (closed) throw new Error(`${FEATURE}: this store has been closed`);
    if (options.migrate !== false) {
      // Shared by every caller, so started in the root context (see root-context.ts).
      migrated ??= inRootContext(() => bootMigrate(sql, migrationSet)).catch((error) => {
        migrated = undefined; // retry on the next call
        throw error;
      });
      await migrated;
    }
    return sql;
  };
  if (options.migrate !== false) registerBootCheck(async () => void await db());
  return {
    async set(id, sealed, ttlSeconds) {
      const client = await db();
      const now = Date.now();
      await client.unsafe(
        `INSERT INTO ${table} (id, data, expires_at) VALUES ($1, $2, $3) ` +
          "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at",
        [id, sealed, Math.round(now + ttlSeconds * 1000)],
      );
      if (now - lastSweep < sweepInterval) return;
      lastSweep = now;
      await client.unsafe(`DELETE FROM ${table} WHERE expires_at <= $1`, [now]);
    },
    async take(id) {
      const [row] = await (await db()).unsafe<{ data: string; expires_at: unknown }>(
        `DELETE FROM ${table} WHERE id = $1 RETURNING data, expires_at`,
        [id],
      );
      return row && (toNumber(row.expires_at) ?? 0) > Date.now() ? row.data : null;
    },
    async delete(id) {
      await (await db()).unsafe(`DELETE FROM ${table} WHERE id = $1`, [id]);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (owned) await sql.close();
    },
  };
}
