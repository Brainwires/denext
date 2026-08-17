// A SQLite-backed {@link CacheStore}, so ISR renders and cached data survive
// process restarts — a durable, dependency-light alternative to the in-memory
// default that needs NO unstable Deno flag (unlike Deno KV / `--unstable-kv`).
//
//   import { setCacheStore, sqliteCacheStore } from "denext/server";
//   setCacheStore(sqliteCacheStore({ path: ".denext/cache.db" }));
//
// The backend is denext's first-party `@denext/sqlite` (a pure-Rust,
// SQLite-3-file-format engine compiled to wasm) via its `node:fs` file backend,
// which runs under Deno. It is a JSR package (zero npm) and is imported lazily on
// first use, so its wasm loads only when this store is actually installed.
// Entries live in three tables (`data`, `pages`, `tags`); a `tags` index
// and a `pages(path)` index drive `deleteByTag`/`deleteByPath` with plain SQL
// rather than the marker bookkeeping the Deno KV adapter needs.
//
// Single-node/single-writer: a local SQLite file is not shared across replicas
// and `rsqlite-wasm`'s file backend has no cross-process locking yet. For
// multi-replica ISR, keep {@link denoKvCacheStore} instead.

import type { CacheStore } from "./cache.ts";

/** The subset of the `rsqlite-wasm` `Database` API this store uses. */
interface RsqliteDatabase {
  exec(sql: string, params?: unknown[]): number;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

/** The subset of the `rsqlite-wasm` module this store needs. */
interface RsqliteModule {
  Database: {
    open(
      path: string,
      options?: { backend?: string },
    ): Promise<RsqliteDatabase>;
  };
}

/** Options for {@linkcode sqliteCacheStore}. */
export interface SqliteCacheStoreOptions {
  /** Path to the on-disk database file. Defaults to `.denext/cache.db`. */
  path?: string;
  /**
   * An already-resolved `@denext/sqlite` module (its `{ Database }` export). When
   * omitted, the package is imported lazily on first use
   * (`import("@denext/sqlite")`). Typed loosely as it is an advanced injection
   * hook (custom build or a test stub).
   */
  module?: unknown;
}

const DEFAULT_PATH = ".denext/cache.db";

const now = (): number => Date.now();

// `Infinity` (no expiry) is stored as SQL NULL; a finite epoch-ms as a REAL.
const toDbExpiry = (expiresAt: number): number | null => expiresAt === Infinity ? null : expiresAt;
const fromDbExpiry = (v: number | null): number => (v == null ? Infinity : v);
const isStale = (v: number | null): boolean => v != null && v <= now();

/** A single row of the `data` table as returned by the engine. */
interface DataRow {
  value: string;
  expires_at: number | null;
  tags: string;
}

/** A single row of the `pages` table as returned by the engine. */
interface PageRow {
  body: string;
  status: number;
  path: string;
  expires_at: number | null;
  stale_at: number | null;
  tags: string;
  csp: string | null;
}

/**
 * A {@link CacheStore} backed by a local SQLite file via the first-party
 * `@denext/sqlite` codec. Durable across restarts and free of any unstable runtime
 * flag (unlike Deno KV) — the recommended store for single-node deployments. For
 * multi-replica sharing use {@linkcode denoKvCacheStore} instead (a local file is
 * single-node).
 *
 * `@denext/sqlite` is a first-party JSR dependency (zero npm), loaded lazily on
 * first use — no import-map setup required. Pass an explicit
 * {@linkcode SqliteCacheStoreOptions.module} to inject a custom build or a stub.
 *
 * @param options File path and optional module override.
 * @returns A store to pass to {@linkcode setCacheStore}.
 */
export function sqliteCacheStore(
  options: SqliteCacheStoreOptions = {},
): CacheStore {
  const path = options.path ?? DEFAULT_PATH;
  let handle: Promise<RsqliteDatabase> | undefined;

  const loadModule = async (): Promise<RsqliteModule> => {
    if (options.module) return options.module as RsqliteModule;
    // First-party JSR dep, imported lazily so its wasm loads only when this store
    // is installed. Marked external in the next-compat build so esbuild never
    // bundles the .wasm (see src/build/next-compat.ts).
    return (await import("@denext/sqlite")) as unknown as RsqliteModule;
  };

  const getDb = (): Promise<RsqliteDatabase> => {
    if (handle) return handle;
    const opening = (async () => {
      const mod = await loadModule();
      const db = await mod.Database.open(path, { backend: "file" });
      // Cache data is regenerable, so trade fsync-per-commit durability for ~50×
      // faster writes: NORMAL skips the per-commit fsync (a crash may lose the last
      // few writes but not corrupt the DB — and a broken cache file just degrades to
      // serving uncached). Guarded: @denext/sqlite < 0.1.3 rejects the pragma, in
      // which case we keep the safe FULL default.
      try {
        db.exec("PRAGMA synchronous = NORMAL");
      } catch {
        // Older @denext/sqlite without synchronous support — stays at FULL.
      }
      // Schema: data/pages keyed by cache key; a tags table + pages(path) index
      // turn invalidation into single DELETEs.
      db.exec(
        "CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL, tags TEXT NOT NULL)",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, body TEXT NOT NULL, status INTEGER NOT NULL, path TEXT NOT NULL, expires_at REAL, stale_at REAL, tags TEXT NOT NULL, csp TEXT)",
      );
      // Migrate a pre-SWR pages table (add the stale_at column if it's missing).
      try {
        db.exec("ALTER TABLE pages ADD COLUMN stale_at REAL");
      } catch {
        // Column already exists — nothing to do.
      }
      // Migrate a pre-CSP pages table (add the csp column if it's missing).
      try {
        db.exec("ALTER TABLE pages ADD COLUMN csp TEXT");
      } catch {
        // Column already exists — nothing to do.
      }
      db.exec(
        "CREATE TABLE IF NOT EXISTS tags (tag TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (tag, ns, key))",
      );
      db.exec("CREATE INDEX IF NOT EXISTS pages_path ON pages (path)");
      return db;
    })();
    // Don't memoize a FAILED open: reset so the next access retries, rather than
    // permanently disabling the cache on a transient lock/FS hiccup at first use.
    opening.catch(() => {
      if (handle === opening) handle = undefined;
    });
    handle = opening;
    return handle;
  };

  // Run a multi-statement write atomically. Without this, a crash or error between
  // the row write and its tag-index rewrite could leave the two out of sync (an
  // entry with stale/missing tags); BEGIN/COMMIT makes each write all-or-nothing.
  const tx = (db: RsqliteDatabase, body: () => void): void => {
    db.exec("BEGIN");
    try {
      body();
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch { /* the failed statement may have already aborted the tx */ }
      throw err;
    }
  };

  // Rewrite the tag index for one entry: drop its old rows, insert the current
  // set. Called on every set so a re-tagged entry can't leak stale tag rows.
  const reindexTags = (
    db: RsqliteDatabase,
    ns: "data" | "page",
    key: string,
    tags: string[],
  ): void => {
    db.exec("DELETE FROM tags WHERE ns = ? AND key = ?", [ns, key]);
    for (const tag of tags) {
      db.exec("INSERT INTO tags (tag, ns, key) VALUES (?, ?, ?)", [tag, ns, key]);
    }
  };

  return {
    async getData(key) {
      const db = await getDb();
      const row = db.query<DataRow>(
        "SELECT value, expires_at, tags FROM data WHERE key = ?",
        [key],
      )[0];
      if (!row) return undefined;
      if (isStale(row.expires_at)) {
        db.exec("DELETE FROM data WHERE key = ?", [key]);
        return undefined;
      }
      return {
        value: JSON.parse(row.value),
        expiresAt: fromDbExpiry(row.expires_at),
        tags: JSON.parse(row.tags),
      };
    },

    async setData(key, entry) {
      const db = await getDb();
      tx(db, () => {
        db.exec("DELETE FROM data WHERE key = ?", [key]);
        db.exec(
          "INSERT INTO data (key, value, expires_at, tags) VALUES (?, ?, ?, ?)",
          [
            key,
            JSON.stringify(entry.value),
            toDbExpiry(entry.expiresAt),
            JSON.stringify(entry.tags),
          ],
        );
        reindexTags(db, "data", key, entry.tags);
      });
    },

    async getPage(key) {
      const db = await getDb();
      const row = db.query<PageRow>(
        "SELECT body, status, path, expires_at, stale_at, tags, csp FROM pages WHERE key = ?",
        [key],
      )[0];
      if (!row) return undefined;
      if (isStale(row.expires_at)) {
        db.exec("DELETE FROM pages WHERE key = ?", [key]);
        return undefined;
      }
      return {
        body: row.body,
        status: row.status,
        path: row.path,
        expiresAt: fromDbExpiry(row.expires_at),
        staleAt: fromDbExpiry(row.stale_at),
        tags: JSON.parse(row.tags),
        csp: row.csp ?? undefined,
      };
    },

    async setPage(key, page) {
      const db = await getDb();
      tx(db, () => {
        db.exec("DELETE FROM pages WHERE key = ?", [key]);
        db.exec(
          "INSERT INTO pages (key, body, status, path, expires_at, stale_at, tags, csp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            key,
            page.body,
            page.status,
            page.path,
            toDbExpiry(page.expiresAt),
            toDbExpiry(page.staleAt ?? Infinity),
            JSON.stringify(page.tags),
            page.csp ?? null,
          ],
        );
        reindexTags(db, "page", key, page.tags);
      });
    },

    async deleteByTag(tag) {
      const db = await getDb();
      tx(db, () => {
        db.exec(
          "DELETE FROM data WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'data')",
          [tag],
        );
        db.exec(
          "DELETE FROM pages WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'page')",
          [tag],
        );
        db.exec("DELETE FROM tags WHERE tag = ?", [tag]);
      });
    },

    async deleteByPath(path) {
      const db = await getDb();
      // Orphaned tag rows for the removed pages are harmless (they carry the
      // page key, so they never mis-delete a sibling) and are cleaned up when
      // the key is next written.
      db.exec("DELETE FROM pages WHERE path = ?", [path]);
    },
  };
}
