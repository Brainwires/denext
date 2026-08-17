/**
 * `@denext/sqlite` — a Deno-native WebAssembly build of
 * [rsqlite-wasm](https://github.com/Brainwires/rsqlite-wasm) `v0.1.2`, a SQLite-3
 * engine written in Rust. Built for Deno with `jsr:@deno/wasmbuild` and the crate's
 * `node:fs` file backend, so it persists to disk **with zero npm dependencies and
 * no `--unstable-*` flag**.
 *
 * denext's {@linkcode https://jsr.io/@denext/denext | sqliteCacheStore} opens this
 * with the `"file"` backend for a durable ISR/page cache.
 *
 * @example A durable, on-disk database
 * ```ts
 * import { Database } from "@denext/sqlite";
 * const db = await Database.open(".denext/cache.db", { backend: "file" });
 * db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
 * db.exec("INSERT INTO kv VALUES (?, ?)", ["a", "1"]);
 * const rows = db.query<{ k: string; v: string }>("SELECT * FROM kv");
 * db.close();
 * ```
 *
 * @module
 */
import { WasmDatabase } from "./lib/denext_sqlite.js";

/** A SQL parameter value accepted by {@linkcode Database.exec}/{@linkcode Database.query}. */
export type SqlValue = string | number | bigint | boolean | Uint8Array | null;

/** A single result row (column name → value). */
export type Row = Record<string, unknown>;

/** Options for {@linkcode Database.open}. */
export interface DatabaseOptions {
  /** `"file"` persists to disk via `node:fs`; `"memory"` (default) is ephemeral. */
  backend?: "memory" | "file";
}

/**
 * A SQLite database backed by rsqlite-wasm. Open with the `"file"` backend for
 * durable, on-disk storage under Deno.
 */
export class Database {
  #inner: WasmDatabase;
  #closed = false;

  private constructor(inner: WasmDatabase) {
    this.#inner = inner;
  }

  /**
   * Open a database. `{ backend: "file" }` persists to `path` via `node:fs`;
   * the default `"memory"` backend is ephemeral.
   *
   * @param path File path for the `"file"` backend (default `"rsqlite.db"`).
   * @param options Backend selection.
   */
  static open(path = "rsqlite.db", options?: DatabaseOptions): Promise<Database> {
    const backend = options?.backend ?? "memory";
    const inner = backend === "file"
      ? WasmDatabase.openWithFile(path)
      : WasmDatabase.openInMemory();
    return Promise.resolve(new Database(inner));
  }

  /**
   * Execute a statement, returning the number of rows affected.
   *
   * @param sql The SQL statement.
   * @param params Bound parameters for `?` placeholders.
   */
  exec(sql: string, params?: SqlValue[]): number {
    this.#ensureOpen();
    return Number(
      params && params.length > 0 ? this.#inner.execParams(sql, params) : this.#inner.exec(sql),
    );
  }

  /**
   * Run a query, returning all result rows as objects.
   *
   * @param sql The SQL query.
   * @param params Bound parameters for `?` placeholders.
   */
  query<T extends Row = Row>(sql: string, params?: SqlValue[]): T[] {
    this.#ensureOpen();
    return (params && params.length > 0
      ? this.#inner.queryParams(sql, params)
      : this.#inner.query(sql)) as T[];
  }

  /** Close the database and free its wasm resources. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inner.close();
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("@denext/sqlite: database is closed");
  }
}
