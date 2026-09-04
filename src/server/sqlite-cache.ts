// A CacheStore backed by Deno's built-in node:sqlite (real SQLite), so ISR renders and
// cached data survive restarts. denext's default durable store, resolved automatically
// at startup (see resolveDefaultCacheStore in cache.ts) with an in-memory fallback — but
// it can also be installed explicitly:
//
//   import { setCacheStore, sqliteCacheStore } from "denext/server";
//   setCacheStore(sqliteCacheStore({ path: ".denext/cache.db" }));
//
// Entries live in three tables (data, pages, tags); a tags index and a pages(path) index
// drive deleteByTag/deleteByPath with plain SQL. The store bounds its footprint — FIFO
// eviction of the oldest rows past a per-table cap, plus a throttled sweep of hard-expired
// rows. Single-node: a local file suits a single instance; for multi-replica, point every
// instance at one shared store via setCacheStore.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CachedPage, CacheEntryTiming, CacheStore, DataEntry } from "./cache.ts";

/** A value bindable as a SQLite statement parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** The minimal SQLite handle this store drives (node:sqlite, or a test stub). */
export interface SqliteDb {
  /** Run a statement for its side effects (DDL/DML), binding `params`. */
  exec(sql: string, params?: SqlValue[]): void;
  /** Run a query, binding `params`, and return the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T[];
  /** Close the underlying database handle. */
  close(): void;
}

/** Options for {@linkcode sqliteCacheStore}. */
export interface SqliteCacheStoreOptions {
  /** Path to the on-disk database file. Defaults to `.denext/cache.db`. */
  path?: string;
  /** Max rows in the `data` table before FIFO eviction of the oldest. Default 1000. */
  maxDataEntries?: number;
  /** Max rows in the `pages` (ISR) table before FIFO eviction. Default 1000. */
  maxPageEntries?: number;
  /** Min ms between proactive hard-expiry sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
  /** Advanced/test hook: open the handle yourself instead of node:sqlite. */
  openDb?: (path: string) => SqliteDb;
}

const DEFAULT_PATH = ".denext/cache.db";
const DEFAULT_MAX_DATA = 1000;
const DEFAULT_MAX_PAGE = 1000;
const SWEEP_INTERVAL = 30_000;

const now = (): number => Date.now();

// `Infinity` (no expiry) is stored as SQL NULL; a finite epoch-ms as a REAL.
const toDbExpiry = (expiresAt: number): number | null => expiresAt === Infinity ? null : expiresAt;
const fromDbExpiry = (v: number | null): number => (v == null ? Infinity : v);
const isStale = (v: number | null): boolean => v != null && v <= now();

/** A single row of the `data` table. */
interface DataRow {
  value: string;
  expires_at: number | null;
  stale_at: number | null;
  tags: string;
}

/** A single row of the `pages` table. */
interface PageRow {
  body: string;
  status: number;
  path: string;
  expires_at: number | null;
  stale_at: number | null;
  tags: string;
  csp: string | null;
  ppr: string | null;
}

// The CachedPage fields NOT stored in their own columns — the PPR/Flight extras a shell
// carries (holeIds, flightShell, …). Serialized to the `ppr` JSON column so a cached PPR
// shell round-trips intact; dropping them would serve a shell verbatim (no hole splicing).
const PPR_FIELDS = [
  "holeIds",
  "routeCsp",
  "headExtras",
  "inTreeTitle",
  "flightShell",
  "flightIslands",
  "flightSignalState",
] as const;

const encodePprExtras = (page: CachedPage): string | null => {
  const extras: Record<string, unknown> = {};
  for (const f of PPR_FIELDS) {
    const v = (page as unknown as Record<string, unknown>)[f];
    if (v !== undefined) extras[f] = v;
  }
  return Object.keys(extras).length ? JSON.stringify(extras) : null;
};

/** Open node:sqlite at `path`, wrapped in the {@link SqliteDb} the store drives. */
function openNodeSqlite(path: string): SqliteDb {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // Directory may already exist; a real perms error surfaces on open below.
    }
  }
  const raw = new DatabaseSync(path);
  return {
    exec(sql, params) {
      if (params && params.length) raw.prepare(sql).run(...params);
      else raw.exec(sql);
    },
    query<T>(sql: string, params?: SqlValue[]): T[] {
      return raw.prepare(sql).all(...(params ?? [])) as T[];
    },
    close() {
      raw.close();
    },
  };
}

/**
 * A {@link CacheStore} backed by Deno's built-in `node:sqlite`. Durable across restarts,
 * zero-npm, no unstable flag — denext's default durable store for single-node deployments
 * (for multi-replica, point every instance at one shared store via {@linkcode
 * setCacheStore}). Size-bounded: FIFO eviction past
 * {@link SqliteCacheStoreOptions.maxDataEntries}/`maxPageEntries`, plus a throttled sweep
 * of hard-expired rows.
 *
 * @param options File path, row caps, and an optional open hook.
 * @returns A store to pass to {@linkcode setCacheStore}.
 */
export function sqliteCacheStore(
  options: SqliteCacheStoreOptions = {},
): CacheStore {
  return new SqliteCache(options);
}

type TagNs = "data" | "page";
type Table = "data" | "pages";

/** Apply the cache's pragmas and create/upgrade the schema on a freshly opened handle. */
function initSchema(d: SqliteDb): void {
  // WAL + NORMAL: the standard high-throughput settings for a regenerable cache. Either
  // may be refused (e.g. :memory:) — keep the default journal / FULL sync then.
  for (const pragma of ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL"]) {
    try {
      d.exec(pragma);
    } catch { /* keep the default */ }
  }
  d.exec(
    "CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL, stale_at REAL, tags TEXT NOT NULL)",
  );
  d.exec(
    "CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, body TEXT NOT NULL, status INTEGER NOT NULL, path TEXT NOT NULL, expires_at REAL, stale_at REAL, tags TEXT NOT NULL, csp TEXT, ppr TEXT)",
  );
  // Add columns for DBs created before they existed (throws if present — ignored).
  const upgrades = [
    "ALTER TABLE data ADD COLUMN stale_at REAL",
    "ALTER TABLE pages ADD COLUMN stale_at REAL",
    "ALTER TABLE pages ADD COLUMN csp TEXT",
    "ALTER TABLE pages ADD COLUMN ppr TEXT",
  ];
  for (const ddl of upgrades) {
    try {
      d.exec(ddl);
    } catch { /* column exists */ }
  }
  d.exec(
    "CREATE TABLE IF NOT EXISTS tags (tag TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (tag, ns, key))",
  );
  d.exec("CREATE INDEX IF NOT EXISTS pages_path ON pages (path)");
  d.exec("CREATE INDEX IF NOT EXISTS tags_ns_key ON tags (ns, key)");
}

// Run a multi-statement write atomically so a row and its tag index can't desync.
function tx(d: SqliteDb, body: () => void): void {
  d.exec("BEGIN");
  try {
    body();
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch { /* the failed statement may have already aborted the tx */ }
    throw err;
  }
}

// Rewrite one entry's tag rows: drop the old set, insert the current one.
function reindexTags(d: SqliteDb, ns: TagNs, key: string, tags: string[]): void {
  d.exec("DELETE FROM tags WHERE ns = ? AND key = ?", [ns, key]);
  for (const tag of tags) {
    d.exec("INSERT INTO tags (tag, ns, key) VALUES (?, ?, ?)", [tag, ns, key]);
  }
}

// FIFO eviction: drop the oldest-inserted rows past `max` (rowid = insertion order),
// cleaning their tag rows first. This bounds non-expiring entries the on-read stale
// eviction never sees. The just-inserted row is newest, so never a victim.
function evict(d: SqliteDb, ns: TagNs, table: Table, max: number): void {
  const n = d.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;
  if (n <= max) return;
  const excess = n - max;
  d.exec(
    `DELETE FROM tags WHERE ns = ? AND key IN (SELECT key FROM ${table} ORDER BY rowid LIMIT ?)`,
    [ns, excess],
  );
  d.exec(
    `DELETE FROM ${table} WHERE key IN (SELECT key FROM ${table} ORDER BY rowid LIMIT ?)`,
    [excess],
  );
}

// Read one row by key, deleting (and missing) it when hard-expired.
function liveRow<T extends { expires_at: number | null }>(
  d: SqliteDb,
  table: Table,
  columns: string,
  key: string,
): T | undefined {
  const row = d.query<T>(`SELECT ${columns} FROM ${table} WHERE key = ?`, [key])[0];
  if (!row) return undefined;
  if (isStale(row.expires_at)) {
    d.exec(`DELETE FROM ${table} WHERE key = ?`, [key]);
    return undefined;
  }
  return row;
}

/** The {@link CacheStore} behind {@linkcode sqliteCacheStore}. */
class SqliteCache implements CacheStore {
  readonly #path: string;
  readonly #maxData: number;
  readonly #maxPage: number;
  readonly #sweepInterval: number;
  readonly #open: (path: string) => SqliteDb;
  #lastSweep = 0;
  #db: SqliteDb | undefined;

  constructor(options: SqliteCacheStoreOptions) {
    this.#path = options.path ?? DEFAULT_PATH;
    this.#maxData = options.maxDataEntries ?? DEFAULT_MAX_DATA;
    this.#maxPage = options.maxPageEntries ?? DEFAULT_MAX_PAGE;
    this.#sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
    this.#open = options.openDb ?? openNodeSqlite;
  }

  #getDb(): SqliteDb {
    if (this.#db) return this.#db;
    const d = this.#open(this.#path);
    initSchema(d);
    // Memoize only after a clean open + init; a throw leaves `#db` unset so the next
    // access retries rather than permanently disabling the cache.
    this.#db = d;
    return d;
  }

  // Proactively reclaim hard-expired rows (finite expires_at in the past). Throttled so a
  // write burst doesn't sweep every call; NULL (never-expires) rows are left to the cap.
  #maybeSweep(d: SqliteDb): void {
    const t = now();
    if (t - this.#lastSweep < this.#sweepInterval) return;
    this.#lastSweep = t;
    for (const [ns, table] of [["data", "data"], ["page", "pages"]] as const) {
      d.exec(
        `DELETE FROM tags WHERE ns = ? AND key IN (SELECT key FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?)`,
        [ns, t],
      );
      d.exec(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [t]);
    }
  }

  // Replace one row inside a transaction, then reindex its tags, evict past the cap and
  // maybe sweep — the shared shape of every write.
  #write(
    ns: TagNs,
    table: Table,
    key: string,
    insert: string,
    params: SqlValue[],
    tags: string[],
  ): void {
    const d = this.#getDb();
    tx(d, () => {
      d.exec(`DELETE FROM ${table} WHERE key = ?`, [key]);
      d.exec(insert, params);
      reindexTags(d, ns, key, tags);
      evict(d, ns, table, ns === "data" ? this.#maxData : this.#maxPage);
      this.#maybeSweep(d);
    });
  }

  getData(key: string): DataEntry | undefined {
    const row = liveRow<DataRow>(this.#getDb(), "data", "value, expires_at, stale_at, tags", key);
    if (!row) return undefined;
    return {
      value: JSON.parse(row.value),
      expiresAt: fromDbExpiry(row.expires_at),
      // NULL ⇒ never stale (DataEntry.staleAt absent); a finite epoch ⇒ SWR point.
      ...(row.stale_at == null ? {} : { staleAt: row.stale_at }),
      tags: JSON.parse(row.tags),
    };
  }

  setData(key: string, entry: DataEntry): void {
    this.#write(
      "data",
      "data",
      key,
      "INSERT INTO data (key, value, expires_at, stale_at, tags) VALUES (?, ?, ?, ?, ?)",
      [
        key,
        JSON.stringify(entry.value),
        toDbExpiry(entry.expiresAt),
        toDbExpiry(entry.staleAt ?? Infinity),
        JSON.stringify(entry.tags),
      ],
      entry.tags,
    );
  }

  getPage(key: string): CachedPage | undefined {
    const row = liveRow<PageRow>(
      this.#getDb(),
      "pages",
      "body, status, path, expires_at, stale_at, tags, csp, ppr",
      key,
    );
    if (!row) return undefined;
    return {
      body: row.body,
      status: row.status,
      path: row.path,
      expiresAt: fromDbExpiry(row.expires_at),
      staleAt: fromDbExpiry(row.stale_at),
      tags: JSON.parse(row.tags),
      csp: row.csp ?? undefined,
      // PPR/Flight shell extras (holeIds, flightShell, …), restored intact.
      ...(row.ppr ? JSON.parse(row.ppr) as Partial<CachedPage> : {}),
    };
  }

  setPage(key: string, page: CachedPage): void {
    this.#write(
      "page",
      "pages",
      key,
      "INSERT INTO pages (key, body, status, path, expires_at, stale_at, tags, csp, ppr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        key,
        page.body,
        page.status,
        page.path,
        toDbExpiry(page.expiresAt),
        toDbExpiry(page.staleAt ?? Infinity),
        JSON.stringify(page.tags),
        page.csp ?? null,
        encodePprExtras(page),
      ],
      page.tags,
    );
  }

  deleteByTag(tag: string): void {
    const d = this.#getDb();
    tx(d, () => {
      d.exec(
        "DELETE FROM data WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'data')",
        [tag],
      );
      d.exec(
        "DELETE FROM pages WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'page')",
        [tag],
      );
      d.exec("DELETE FROM tags WHERE tag = ?", [tag]);
    });
  }

  deleteByPath(urlPath: string): void {
    const d = this.#getDb();
    // Delete the affected pages' tag rows first (in one tx), then the pages. The `tags`
    // table has no size cap of its own, so leaving tag rows behind here — the one write
    // path that doesn't reindex/evict them — would grow the table without bound under
    // repeated `revalidatePath` on tagged pages, slowing every tag subquery over time.
    tx(d, () => {
      d.exec(
        "DELETE FROM tags WHERE ns = 'page' AND key IN (SELECT key FROM pages WHERE path = ?)",
        [urlPath],
      );
      d.exec("DELETE FROM pages WHERE path = ?", [urlPath]);
    });
  }

  // Soft-expire (SWR): rewrite the timing of every entry carrying `tag` in place instead
  // of deleting it, so revalidateTag(tag, profile) serves stale while a refresh runs.
  expireByTag(tag: string, timing: CacheEntryTiming): void {
    const d = this.#getDb();
    const params = [toDbExpiry(timing.staleAt), toDbExpiry(timing.expiresAt), tag];
    tx(d, () => {
      d.exec(
        "UPDATE data SET stale_at = ?, expires_at = ? " +
          "WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'data')",
        params,
      );
      d.exec(
        "UPDATE pages SET stale_at = ?, expires_at = ? " +
          "WHERE key IN (SELECT key FROM tags WHERE tag = ? AND ns = 'page')",
        params,
      );
    });
  }
}
