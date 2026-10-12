/**
 * A {@linkcode CacheStore} on Postgres: the data cache (`unstable_cache`, `"use cache"`) and
 * the page (ISR) cache shared by every replica, so `revalidateTag` / `revalidatePath` on one
 * instance invalidates what all of them serve.
 *
 * ```ts
 * import { postgresCacheStore, setCacheStore } from "denext/server";
 * setCacheStore(postgresCacheStore({ url: Deno.env.get("DATABASE_URL") }));
 * ```
 *
 * Entries live in `cache_data`, `cache_pages` and a `cache_tags` index, created by migrations
 * (recorded in `cache_migrations`) on first use. Like the SQLite store it bounds its
 * footprint: past a per-table cap the oldest-written rows go, and hard-expired rows are swept
 * on a throttle. Every multi-statement write is one transaction, so a row and its tag index
 * never disagree.
 *
 * @module
 */

import type { CachedPage, CacheEntryTiming, CacheStore, DataEntry } from "./cache.ts";
import { encodePprExtras } from "./cache-ppr.ts";
import {
  type PostgresConnectionOptions,
  resolveConnection,
  schemaPrefix,
  type SqlClient,
  type SqlRow,
  toNumber,
} from "./postgres.ts";
import { migratePostgres, type Migration } from "./postgres-migrate.ts";
import { inRootContext } from "./root-context.ts";

/** Options for {@linkcode postgresCacheStore}. */
export interface PostgresCacheStoreOptions extends PostgresConnectionOptions {
  /** Max rows in `cache_data` before the oldest-written are evicted. Default 1000. */
  maxDataEntries?: number;
  /** Max rows in `cache_pages` before the oldest-written are evicted. Default 1000. */
  maxPageEntries?: number;
  /** Min ms between proactive hard-expiry sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
  /** Apply the cache migrations on first use (default `true`). */
  migrate?: boolean;
}

const DEFAULT_MAX = 1000;
const SWEEP_INTERVAL = 30_000;

/** The cache schema, as migrations. `p` qualifies a table. */
function cacheMigrations(p: string): Migration[] {
  return [{
    name: "0001_cache_tables",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}cache_data (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at DOUBLE PRECISION,
  stale_at DOUBLE PRECISION, tags TEXT NOT NULL, written_at DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS cache_data_written ON ${p}cache_data (written_at);
CREATE TABLE IF NOT EXISTS ${p}cache_pages (
  key TEXT PRIMARY KEY, body TEXT NOT NULL, status INTEGER NOT NULL, path TEXT NOT NULL,
  expires_at DOUBLE PRECISION, stale_at DOUBLE PRECISION, tags TEXT NOT NULL, csp TEXT,
  ppr TEXT, written_at DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS cache_pages_path ON ${p}cache_pages (path);
CREATE INDEX IF NOT EXISTS cache_pages_written ON ${p}cache_pages (written_at);
CREATE TABLE IF NOT EXISTS ${p}cache_tags (
  tag TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (tag, ns, key));
CREATE INDEX IF NOT EXISTS cache_tags_ns_key ON ${p}cache_tags (ns, key);
`,
  }];
}

// `Infinity` (no expiry) is stored as SQL NULL; a finite epoch-ms as a double.
const toDbExpiry = (at: number): number | null => at === Infinity ? null : at;
const fromDbExpiry = (v: unknown): number => toNumber(v) ?? Infinity;

type Ns = "data" | "page";

/** The table of one namespace. */
const TABLE: Record<Ns, string> = { data: "cache_data", page: "cache_pages" };

/** The {@link CacheStore} behind {@linkcode postgresCacheStore}. */
class PostgresCache implements CacheStore {
  readonly #sql: SqlClient;
  readonly #owned: boolean;
  readonly #p: string;
  readonly #max: Record<Ns, number>;
  readonly #sweepInterval: number;
  readonly #options: PostgresCacheStoreOptions;
  #migrated: Promise<unknown> | undefined;
  #lastSweep = 0;

  constructor(options: PostgresCacheStoreOptions) {
    this.#p = schemaPrefix(options.schema, "postgresCacheStore");
    const { sql, owned } = resolveConnection(options, "postgresCacheStore");
    this.#sql = sql;
    this.#owned = owned;
    this.#options = options;
    this.#max = {
      data: options.maxDataEntries ?? DEFAULT_MAX,
      page: options.maxPageEntries ?? DEFAULT_MAX,
    };
    this.#sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
  }

  /** A table's qualified name. */
  #t(name: string): string {
    return `${this.#p}${name}`;
  }

  /** The client, once the cache migrations have run (shared by concurrent first calls). */
  async #db(): Promise<SqlClient> {
    if (this.#options.migrate !== false) {
      // Shared by every request, so started in the root context (see root-context.ts).
      this.#migrated ??= inRootContext(() =>
        migratePostgres(this.#sql, {
          migrations: cacheMigrations(this.#p),
          table: "cache_migrations",
          schema: this.#options.schema,
        })
      ).catch((error) => {
        this.#migrated = undefined; // retry on the next access, never disable the cache
        throw error;
      });
      await this.#migrated;
    }
    return this.#sql;
  }

  /** One row by key, deleting (and missing) it when hard-expired. */
  async #live(ns: Ns, columns: string, key: string): Promise<SqlRow | undefined> {
    const db = await this.#db();
    const table = this.#t(TABLE[ns]);
    const [row] = await db.unsafe(`SELECT ${columns} FROM ${table} WHERE key = $1`, [key]);
    if (!row) return undefined;
    const expires = toNumber(row.expires_at);
    if (expires !== undefined && expires <= Date.now()) {
      await db.unsafe(`DELETE FROM ${table} WHERE key = $1`, [key]);
      return undefined;
    }
    return row;
  }

  /**
   * Upsert one row, rewrite its tag rows, evict past the cap and maybe sweep — in one
   * transaction, so the row and its index agree.
   */
  async #write(ns: Ns, key: string, values: Record<string, unknown>, tags: string[]) {
    const db = await this.#db();
    const table = this.#t(TABLE[ns]);
    const tagTable = this.#t("cache_tags");
    const columns = ["key", ...Object.keys(values), "written_at"];
    const params = [key, ...Object.values(values), Date.now()];
    const updates = columns.slice(1).map((c) => `${c} = EXCLUDED.${c}`);
    await db.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ${table} (${columns.join(", ")}) ` +
          `VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) ` +
          `ON CONFLICT (key) DO UPDATE SET ${updates.join(", ")}`,
        params,
      );
      await tx.unsafe(`DELETE FROM ${tagTable} WHERE ns = $1 AND key = $2`, [ns, key]);
      if (tags.length) {
        // DO NOTHING: two replicas writing one key at once both index it, neither fails.
        await tx.unsafe(
          `INSERT INTO ${tagTable} (tag, ns, key) VALUES ` +
            tags.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ") +
            " ON CONFLICT DO NOTHING",
          tags.flatMap((tag) => [tag, ns, key]),
        );
      }
      await this.#evict(tx, ns);
      await this.#maybeSweep(tx);
    });
  }

  /** Drop the oldest-written rows past the namespace's cap, their tag rows first. */
  async #evict(tx: SqlClient, ns: Ns): Promise<void> {
    const table = this.#t(TABLE[ns]);
    const [row] = await tx.unsafe(`SELECT COUNT(*) AS n FROM ${table}`);
    const excess = (toNumber(row?.n) ?? 0) - this.#max[ns];
    if (excess <= 0) return;
    const oldest = `SELECT key FROM ${table} ORDER BY written_at, key LIMIT $2`;
    await tx.unsafe(
      `DELETE FROM ${this.#t("cache_tags")} WHERE ns = $1 AND key IN (${oldest})`,
      [ns, excess],
    );
    await tx.unsafe(
      `DELETE FROM ${table} WHERE key IN (SELECT key FROM ${table} ORDER BY written_at, key ` +
        "LIMIT $1)",
      [excess],
    );
  }

  /** Reclaim hard-expired rows, throttled; never-expiring ones are left to the cap. */
  async #maybeSweep(tx: SqlClient): Promise<void> {
    const now = Date.now();
    if (now - this.#lastSweep < this.#sweepInterval) return;
    this.#lastSweep = now;
    for (const ns of ["data", "page"] as const) {
      const table = this.#t(TABLE[ns]);
      await tx.unsafe(
        `DELETE FROM ${this.#t("cache_tags")} WHERE ns = $1 AND key IN ` +
          `(SELECT key FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= $2)`,
        [ns, now],
      );
      await tx.unsafe(
        `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= $1`,
        [now],
      );
    }
  }

  async getData(key: string): Promise<DataEntry | undefined> {
    const row = await this.#live("data", "value, expires_at, stale_at, tags", key);
    if (!row) return undefined;
    const staleAt = toNumber(row.stale_at);
    return {
      value: JSON.parse(row.value as string),
      expiresAt: fromDbExpiry(row.expires_at),
      ...(staleAt === undefined ? {} : { staleAt }),
      tags: JSON.parse(row.tags as string),
    };
  }

  async setData(key: string, entry: DataEntry): Promise<void> {
    await this.#write("data", key, {
      value: JSON.stringify(entry.value),
      expires_at: toDbExpiry(entry.expiresAt),
      stale_at: toDbExpiry(entry.staleAt ?? Infinity),
      tags: JSON.stringify(entry.tags),
    }, entry.tags);
  }

  async getPage(key: string): Promise<CachedPage | undefined> {
    const row = await this.#live(
      "page",
      "body, status, path, expires_at, stale_at, tags, csp, ppr",
      key,
    );
    if (!row) return undefined;
    return {
      body: row.body as string,
      status: toNumber(row.status) ?? 200,
      path: row.path as string,
      expiresAt: fromDbExpiry(row.expires_at),
      staleAt: fromDbExpiry(row.stale_at),
      tags: JSON.parse(row.tags as string),
      csp: typeof row.csp === "string" ? row.csp : undefined,
      ...(typeof row.ppr === "string" ? JSON.parse(row.ppr) as Partial<CachedPage> : {}),
    };
  }

  async setPage(key: string, page: CachedPage): Promise<void> {
    await this.#write("page", key, {
      body: page.body,
      status: page.status,
      path: page.path,
      expires_at: toDbExpiry(page.expiresAt),
      stale_at: toDbExpiry(page.staleAt ?? Infinity),
      tags: JSON.stringify(page.tags),
      csp: page.csp ?? null,
      ppr: encodePprExtras(page),
    }, page.tags);
  }

  async deleteByTag(tag: string): Promise<void> {
    const tags = this.#t("cache_tags");
    await (await this.#db()).begin(async (tx) => {
      for (const ns of ["data", "page"] as const) {
        await tx.unsafe(
          `DELETE FROM ${this.#t(TABLE[ns])} WHERE key IN ` +
            `(SELECT key FROM ${tags} WHERE tag = $1 AND ns = $2)`,
          [tag, ns],
        );
      }
      await tx.unsafe(`DELETE FROM ${tags} WHERE tag = $1`, [tag]);
    });
  }

  async deleteByPath(path: string): Promise<void> {
    const pages = this.#t("cache_pages");
    await (await this.#db()).begin(async (tx) => {
      // The pages' tag rows first: the tags table has no cap of its own.
      await tx.unsafe(
        `DELETE FROM ${this.#t("cache_tags")} WHERE ns = 'page' AND key IN ` +
          `(SELECT key FROM ${pages} WHERE path = $1)`,
        [path],
      );
      await tx.unsafe(`DELETE FROM ${pages} WHERE path = $1`, [path]);
    });
  }

  async expireByTag(tag: string, timing: CacheEntryTiming): Promise<void> {
    const tags = this.#t("cache_tags");
    const params = [toDbExpiry(timing.staleAt), toDbExpiry(timing.expiresAt), tag];
    await (await this.#db()).begin(async (tx) => {
      for (const ns of ["data", "page"] as const) {
        await tx.unsafe(
          `UPDATE ${this.#t(TABLE[ns])} SET stale_at = $1, expires_at = $2 WHERE key IN ` +
            `(SELECT key FROM ${tags} WHERE tag = $3 AND ns = '${ns}')`,
          params,
        );
      }
    });
  }

  async sweepPages(keep: string): Promise<number> {
    const pages = this.#t("cache_pages");
    // A prefix compare, not LIKE: no wildcard in the kept prefix can widen the match.
    const other = "substr(key, 1, $1) <> $2";
    const params = [keep.length, keep];
    return await (await this.#db()).begin(async (tx) => {
      await tx.unsafe(
        `DELETE FROM ${this.#t("cache_tags")} WHERE ns = 'page' AND key IN ` +
          `(SELECT key FROM ${pages} WHERE ${other})`,
        params,
      );
      return (await tx.unsafe(`DELETE FROM ${pages} WHERE ${other} RETURNING key`, params)).length;
    });
  }

  /** Close the client when this store opened it (from `url`). */
  async close(): Promise<void> {
    if (this.#owned) await this.#sql.close();
  }
}

/**
 * A {@link CacheStore} on Postgres, shared by every replica. Size-bounded: oldest-written rows
 * past `maxDataEntries` / `maxPageEntries` are evicted, and hard-expired rows are swept on a
 * throttle.
 *
 * @param options `sql` (a client) or `url` (opened with `Deno.SQL`), an optional `schema`, the
 *   row caps, the sweep interval and `migrate`.
 * @returns A store to pass to {@linkcode setCacheStore}; its `close()` closes a client it opened.
 * @throws {PostgresUnsupportedError} For `url` on a Deno without `Deno.SQL` (pass `sql`).
 */
export function postgresCacheStore(
  options: PostgresCacheStoreOptions,
): CacheStore & { close(): Promise<void> } {
  return new PostgresCache(options);
}
