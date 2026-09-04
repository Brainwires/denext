/**
 * A {@linkcode SessionStore} backed by Deno's built-in `node:sqlite` (real SQLite, zero
 * npm), so revocable auth sessions survive a restart:
 *
 * ```ts
 * import { denextAuth, sqliteSessionStore } from "denext/server";
 * denextAuth({ ..., sessionStore: sqliteSessionStore({ path: ".denext/sessions.db" }) });
 * ```
 *
 * Single-node: a local file suits one instance (every replica must see the same store —
 * for multi-replica, mount one shared volume or implement `SessionStore` over your
 * shared database). Expired rows are reclaimed by a throttled sweep on writes; the
 * plugin closes the handle on server drain via its teardown seam.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqliteDb, SqlValue } from "../sqlite-cache.ts";
import type { SessionStore } from "./session-store.ts";
import type { AuthSession } from "./types.ts";

/** Options for {@linkcode sqliteSessionStore}. */
export interface SqliteSessionStoreOptions {
  /** Path to the on-disk database file. Defaults to `.denext/sessions.db`. */
  path?: string;
  /** Min ms between proactive expired-row sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
  /** Advanced/test hook: open the handle yourself instead of node:sqlite. */
  openDb?: (path: string) => SqliteDb;
}

const DEFAULT_PATH = ".denext/sessions.db";
const SWEEP_INTERVAL = 30_000;

/** Open node:sqlite at `path` behind the {@link SqliteDb} interface this store drives. */
function openNodeSqlite(path: string): SqliteDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  const exec = (sql: string, params: SqlValue[] = []): void =>
    void (params.length ? raw.prepare(sql).run(...params) : raw.exec(sql));
  const query = <T>(sql: string, params: SqlValue[] = []): T[] =>
    raw.prepare(sql).all(...params) as T[];
  return { exec, query, close: () => raw.close() };
}

/** Create the table + indexes (idempotent) and set the usual WAL pragmas. */
function initSchema(d: SqliteDb): void {
  try {
    d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  } catch { /* a handle that refuses pragmas keeps its defaults */ }
  d.exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, " +
      "payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  d.exec("CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)");
  d.exec("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at)");
}

/**
 * A durable {@linkcode SessionStore} on Deno's built-in `node:sqlite`.
 *
 * @param options File path, sweep interval, and an optional open hook.
 * @returns A store to pass as `denextAuth({ sessionStore })`.
 */
export function sqliteSessionStore(options: SqliteSessionStoreOptions = {}): SessionStore {
  const path = options.path ?? DEFAULT_PATH;
  const sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
  const open = options.openDb ?? openNodeSqlite;
  let db: SqliteDb | undefined;
  let lastSweep = 0;

  // Memoize only after a clean open + init; a throw leaves `db` unset so the next access
  // retries instead of permanently disabling sign-in.
  const getDb = (): SqliteDb => {
    if (db) return db;
    const d = open(path);
    initSchema(d);
    db = d;
    return db;
  };

  // Reclaim expired rows, throttled so a sign-in burst doesn't sweep on every write.
  const maybeSweep = (d: SqliteDb): void => {
    const now = Date.now();
    if (now - lastSweep < sweepInterval) return;
    lastSweep = now;
    d.exec("DELETE FROM sessions WHERE expires_at <= ?", [Math.floor(now / 1000)]);
  };

  return {
    create(id, session) {
      const d = getDb();
      d.exec(
        "INSERT OR REPLACE INTO sessions (id, user_id, payload, expires_at) VALUES (?, ?, ?, ?)",
        [id, session.user.id, JSON.stringify(session), session.expiresAt],
      );
      maybeSweep(d);
    },
    get(id) {
      const row = getDb().query<{ payload: string }>(
        "SELECT payload FROM sessions WHERE id = ? AND expires_at > ?",
        [id, Math.floor(Date.now() / 1000)],
      )[0];
      return row ? JSON.parse(row.payload) as AuthSession : undefined;
    },
    delete(id) {
      getDb().exec("DELETE FROM sessions WHERE id = ?", [id]);
    },
    deleteByUser(userId) {
      getDb().exec("DELETE FROM sessions WHERE user_id = ?", [userId]);
    },
    close() {
      db?.close();
      db = undefined;
    },
  };
}
