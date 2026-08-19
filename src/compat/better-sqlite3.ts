/**
 * `better-sqlite3` compat over Deno's built-in `node:sqlite` (no native npm
 * addon). Alias `better-sqlite3` to this module:
 *
 * ```jsonc
 * "imports": { "better-sqlite3": "jsr:@denext/denext/better-sqlite3" }
 * ```
 *
 * Implements the surface most apps and ORMs (e.g. Drizzle's better-sqlite3
 * driver) use: `new Database(path, opts)`, `prepare().run/get/all/iterate`,
 * `.pluck()/.raw()`, `exec`, `pragma`, `transaction` (with nesting via
 * savepoints), `function`, and `close`. `node:sqlite` is a Deno built-in, so
 * this adds no dependency.
 *
 * @module
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

/** better-sqlite3 constructor options (the supported subset). */
export interface DatabaseOptions {
  /** Open read-only. */
  readonly?: boolean;
  /** Require the file to already exist (do not create it). */
  fileMustExist?: boolean;
  /** Open in-memory (equivalent to a `":memory:"` filename). */
  memory?: boolean;
  /** Verbose logger called with each executed SQL string. */
  verbose?: (message?: unknown, ...args: unknown[]) => void;
}

/** The result of a mutating statement, as better-sqlite3 returns it. */
export interface RunResult {
  /** Rows changed. */
  changes: number;
  /** The rowid of the last inserted row. */
  lastInsertRowid: number | bigint;
}

/** Positional (or single named-object) bind parameters for a statement. */
export type Params = unknown[];

/** Coerce a possibly-bigint rowid to a Number when it fits safely. */
function coerceRowid(v: number | bigint): number | bigint {
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  return v;
}

/**
 * Column metadata for a statement's result, as better-sqlite3's `columns()`
 * returns it (mirrors `node:sqlite`'s shape).
 */
export interface ColumnDefinition {
  /** The result column name (respecting `AS` aliases). */
  name: string;
  /** The origin column name, or `null` for an expression. */
  column: string | null;
  /** The origin table name, or `null`. */
  table: string | null;
  /** The origin database name, or `null`. */
  database: string | null;
  /** The declared column type, or `null`. */
  type: string | null;
}

/** A prepared statement wrapping a `node:sqlite` `StatementSync`. */
export class Statement {
  #stmt: StatementSync;
  #pluck = false;
  #raw = false;
  #expand = false;
  // Parameters bound via `.bind()` — reused by run/get/all when they get no args
  // (better-sqlite3 lets you pre-bind once, then call run/get/all with none).
  #bound: unknown[] | null = null;
  /** The SQL source of this statement. */
  readonly source: string;

  /**
   * Wrap a prepared `node:sqlite` statement.
   *
   * @param stmt The underlying `node:sqlite` statement.
   * @param source The SQL source text.
   */
  constructor(stmt: StatementSync, source: string) {
    this.#stmt = stmt;
    this.source = source;
  }

  // Effective bind parameters: the call's own args, else the pre-bound ones.
  #params(params: Params): Params {
    return params.length > 0 ? params : (this.#bound ?? []);
  }

  /** Execute with `params`, returning `{ changes, lastInsertRowid }`. */
  run(...params: Params): RunResult {
    const r = this.#stmt.run(...(this.#params(params) as never[]));
    return { changes: Number(r.changes), lastInsertRowid: coerceRowid(r.lastInsertRowid) };
  }

  /** Return the first matching row (shaped by pluck/raw), or `undefined`. */
  get(...params: Params): unknown {
    return this.#shape(
      this.#stmt.get(...(this.#params(params) as never[])) as Record<string, unknown> | undefined,
    );
  }

  /** Return all matching rows (each shaped by pluck/raw). */
  all(...params: Params): unknown[] {
    return (this.#stmt.all(...(this.#params(params) as never[])) as Record<string, unknown>[]).map(
      (r) => this.#shape(r),
    );
  }

  /** Iterate matching rows lazily (falls back to `all` if unsupported). */
  *iterate(...params: Params): IterableIterator<unknown> {
    const iter = (this.#stmt as { iterate?: (...p: never[]) => Iterable<Record<string, unknown>> })
      .iterate;
    if (typeof iter === "function") {
      for (const row of iter.call(this.#stmt, ...(this.#params(params) as never[]))) {
        yield this.#shape(row);
      }
    } else {
      for (const row of this.all(...params)) yield row;
    }
  }

  /**
   * Pre-bind parameters, returning this statement so run/get/all can be called
   * with no args (better-sqlite3 semantics). A single array argument is spread as
   * positional parameters. Can only be called once, before any execution.
   */
  bind(...params: Params): this {
    if (this.#bound !== null) {
      throw new TypeError("The bind() method can only be invoked once per statement");
    }
    this.#bound = params.length === 1 && Array.isArray(params[0])
      ? (params[0] as unknown[])
      : params;
    return this;
  }

  /** Whether this statement returns rows (a `SELECT`/reader), per its columns. */
  get reader(): boolean {
    return this.columns().length > 0;
  }

  /** The result columns' metadata (empty for a non-reader statement). */
  columns(): ColumnDefinition[] {
    const cols = (this.#stmt as { columns?: () => ColumnDefinition[] }).columns;
    return typeof cols === "function" ? cols.call(this.#stmt) : [];
  }

  /**
   * Read integer columns as `BigInt` (better-sqlite3's `safeIntegers`), backed by
   * `node:sqlite`'s `setReadBigInts`. No-op if unsupported by this runtime.
   */
  safeIntegers(toggle = true): this {
    const set = (this.#stmt as { setReadBigInts?: (t: boolean) => void }).setReadBigInts;
    if (typeof set === "function") set.call(this.#stmt, toggle);
    return this;
  }

  /** Return only the first column of each row. */
  pluck(toggle = true): this {
    this.#pluck = toggle;
    return this;
  }
  /** Return each row as an array of column values. */
  raw(toggle = true): this {
    this.#raw = toggle;
    return this;
  }
  /** (No-op placeholder for better-sqlite3's `expand`.) */
  expand(toggle = true): this {
    this.#expand = toggle;
    return this;
  }

  #shape(row: Record<string, unknown> | undefined): unknown {
    if (!row) return row;
    if (this.#pluck) return Object.values(row)[0];
    if (this.#raw) return Object.values(row);
    return row;
  }
}

/** A transaction function, callable and with mode variants (better-sqlite3). */
export interface TransactionFunction<A extends unknown[] = unknown[], R = unknown> {
  /** Run the transaction with the default (deferred) mode. */
  (...args: A): R;
  /** Run wrapped in `BEGIN DEFERRED`. */
  deferred: (...args: A) => R;
  /** Run wrapped in `BEGIN IMMEDIATE`. */
  immediate: (...args: A) => R;
  /** Run wrapped in `BEGIN EXCLUSIVE`. */
  exclusive: (...args: A) => R;
}

/** A SQLite database, wrapping `node:sqlite`'s `DatabaseSync`. */
export default class Database {
  #db: DatabaseSync;
  #depth = 0;
  #open = true;
  /** The database filename (or `":memory:"`). */
  readonly name: string;
  /** Whether the database was opened read-only. */
  readonly readonly: boolean;
  /** Whether the database is in-memory. */
  readonly memory: boolean;
  #verbose?: (message?: unknown, ...args: unknown[]) => void;
  #safeIntegers = false;

  /**
   * Open (or create) a SQLite database.
   *
   * @param filename The database path, or `":memory:"`.
   * @param options better-sqlite3-style options.
   */
  constructor(filename = ":memory:", options: DatabaseOptions = {}) {
    this.name = options.memory ? ":memory:" : filename;
    this.readonly = options.readonly ?? false;
    this.memory = options.memory ?? filename === ":memory:";
    this.#verbose = options.verbose;
    // node:sqlite creates the file by default; honor better-sqlite3's
    // `fileMustExist` by failing fast when the file is absent (matches the real
    // library, which throws rather than silently creating an empty database).
    if (options.fileMustExist && !this.memory) {
      try {
        Deno.statSync(filename);
      } catch {
        throw new Error(
          `better-sqlite3 compat: database file does not exist: ${filename} (fileMustExist)`,
        );
      }
    }
    this.#db = new DatabaseSync(this.name, { readOnly: this.readonly });
  }

  /** Whether the connection is open. */
  get open(): boolean {
    return this.#open;
  }

  /** Whether a transaction is currently active. */
  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /** Prepare `sql` into a reusable {@link Statement}. */
  prepare(sql: string): Statement {
    this.#verbose?.(sql);
    const stmt = new Statement(this.#db.prepare(sql), sql);
    if (this.#safeIntegers) stmt.safeIntegers(true);
    return stmt;
  }

  /**
   * Read integer columns as `BigInt` for every statement prepared afterwards
   * (better-sqlite3's `defaultSafeIntegers`). Prisma's better-sqlite3 driver
   * adapter enables this so large integers round-trip losslessly.
   *
   * @param toggle Whether to default new statements to BigInt integers.
   */
  defaultSafeIntegers(toggle = true): this {
    this.#safeIntegers = toggle;
    return this;
  }

  /** Execute one or more SQL statements (no result). */
  exec(sql: string): this {
    this.#verbose?.(sql);
    this.#db.exec(sql);
    return this;
  }

  /**
   * Run `PRAGMA source`. With `{ simple: true }`, return just the first column
   * of the first row; otherwise return all rows.
   *
   * @param source The pragma body, e.g. `"journal_mode = WAL"`.
   * @param options `{ simple }` to return a scalar.
   */
  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.#db.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    if (options.simple) return rows[0] ? Object.values(rows[0])[0] : undefined;
    return rows;
  }

  /**
   * Register a scalar user-defined function (best-effort; requires
   * `node:sqlite` function support).
   *
   * @param name The SQL function name.
   * @param fn The implementation.
   */
  function(name: string, fn: (...args: unknown[]) => unknown): this {
    const register = (this.#db as { function?: (n: string, f: unknown) => void }).function;
    if (typeof register !== "function") {
      throw new Error("better-sqlite3 compat: node:sqlite user functions are unavailable here.");
    }
    register.call(this.#db, name, fn);
    return this;
  }

  /**
   * Wrap `fn` so calling the returned function runs it inside a transaction
   * (nested calls use savepoints). Exposes `.deferred/.immediate/.exclusive`.
   *
   * @param fn The function to run transactionally.
   * @returns A {@link TransactionFunction}.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R> {
    const runWith = (mode: string) => (...args: A): R => {
      const nested = this.#depth > 0;
      const name = `_dnx_sp_${this.#depth}`;
      this.#db.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.#db.exec(nested ? `RELEASE ${name}` : "COMMIT");
        // Decrement only after a successful commit — so a throwing COMMIT lands
        // in catch with depth still un-decremented, decrementing exactly once.
        this.#depth--;
        return result;
      } catch (err) {
        this.#depth--;
        if (nested) {
          // `ROLLBACK TO` rewinds the savepoint but leaves it on the stack, so also
          // `RELEASE` it (matching better-sqlite3) — otherwise it lingers/leaks.
          this.#db.exec(`ROLLBACK TO ${name}`);
          this.#db.exec(`RELEASE ${name}`);
        } else {
          this.#db.exec("ROLLBACK");
        }
        throw err;
      }
    };
    const tx = runWith("DEFERRED") as TransactionFunction<A, R>;
    tx.deferred = runWith("DEFERRED");
    tx.immediate = runWith("IMMEDIATE");
    tx.exclusive = runWith("EXCLUSIVE");
    return tx;
  }

  /** Close the database connection. */
  close(): this {
    this.#db.close();
    this.#open = false;
    return this;
  }
}

/** Named export mirroring `import { Database } from "better-sqlite3"` usage. */
export { Database };
