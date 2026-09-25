/**
 * `expo-sqlite` for denext: SDK 57's async API over `denext/mobile`'s
 * {@linkcode openSqlite} (a file through `@capacitor-community/sqlite` in the Capacitor shell;
 * the app's own `@sqlite.org/sqlite-wasm` in a worker on the web, persisted to OPFS without
 * cross-origin isolation).
 *
 * Expo's synchronous API (`openDatabaseSync`, `runSync`, `getAllSync`, …) runs over JSI; the
 * Capacitor bridge and the web worker are asynchronous, so it is not provided. Nor are
 * sessions, extensions, serialization, backups, change listeners, libSQL sync or the
 * `kv-store` / `localStorage/install` entry points.
 *
 * @example
 * ```ts
 * import * as SQLite from "denext/expo/sqlite";
 *
 * const db = await SQLite.openDatabaseAsync("app.db");
 * await db.execAsync("CREATE TABLE IF NOT EXISTS todo (id INTEGER PRIMARY KEY, title TEXT)");
 * const { lastInsertRowId } = await db.runAsync("INSERT INTO todo (title) VALUES (?)", "milk");
 * const rows = await db.getAllAsync<{ id: number; title: string }>("SELECT * FROM todo");
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import { useContext, useEffect, useState } from "../runtime/hooks.ts";
import {
  deleteSqlite,
  openSqlite,
  type SqliteBindValue,
  type SqliteDatabase,
  type SqliteParams,
  type SqliteRows,
} from "../mobile/sqlite.ts";

/** A value a statement binds. */
export type SQLiteBindValue = SqliteBindValue;
/** A statement's parameters as one argument: an array, or a record keyed by placeholder. */
export type SQLiteBindParams = Record<string, SQLiteBindValue> | SQLiteBindValue[];
/** A statement's parameters spread as arguments. */
export type SQLiteVariadicBindParams = SQLiteBindValue[];

/** What a write reports. */
export interface SQLiteRunResult {
  /** The rowid of the last inserted row. */
  lastInsertRowId: number;
  /** Rows changed. */
  changes: number;
}

/** Options for {@linkcode openDatabaseAsync} (accepted; none changes the behaviour here). */
export interface SQLiteOpenOptions {
  /** Report changes to `addDatabaseChangeListener` (not provided here). */
  enableChangeListener?: boolean;
  /** Open a separate connection. */
  useNewConnection?: boolean;
  /** Finalize prepared statements left open on close. */
  finalizeUnusedStatementsBeforeClosing?: boolean;
  /** libSQL sync (not provided here). */
  libSQLOptions?: { url: string; authToken: string; remoteOnly?: boolean };
}

/** The folder databases live in (a name only: the backing decides the real place). */
export const defaultDatabaseDirectory: string = "SQLite";

/** SQLite extensions bundled with the native build: none here. */
export const bundledExtensions: Record<
  string,
  { libPath: string; entryPoint: string } | undefined
> = {};

/** One argument or the spread form, as one params value. */
function paramsOf(params: unknown[]): SqliteParams {
  if (params.length === 1) {
    const only = params[0];
    if (Array.isArray(only)) return only as SQLiteBindValue[];
    if (
      only !== null && typeof only === "object" && !(only instanceof Uint8Array) &&
      !(only instanceof ArrayBuffer)
    ) return only as Record<string, SQLiteBindValue>;
  }
  return params as SQLiteBindValue[];
}

/** A value-row result as objects. */
function objects<T>({ columns, rows }: SqliteRows): T[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((column, i) => (obj[column] = row[i]));
    return obj as T;
  });
}

/**
 * A FIFO lock: `withExclusiveTransactionAsync` holds it for its whole transaction, and
 * every other call on the database waits for it. (Expo opens a second native connection for
 * an exclusive transaction; the plugin and the worker have one per database.)
 */
class Lock {
  #tail: Promise<void> = Promise.resolve();

  /** Run `fn` once every earlier holder is done. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

/** The iterator every `…EachAsync` / statement result is: rows one at a time. */
function rowIterator<T>(load: () => Promise<T[]>): AsyncIterableIterator<T> {
  let rows: T[] | null = null;
  let i = 0;
  const iterator: AsyncIterableIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      rows ??= await load();
      return i < rows.length ? { value: rows[i++], done: false } : { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** What {@linkcode SQLiteStatement.executeAsync} resolves to. */
export interface SQLiteExecuteAsyncResult<T> extends AsyncIterableIterator<T> {
  /** The rowid of the last inserted row. */
  readonly lastInsertRowId: number;
  /** Rows changed. */
  readonly changes: number;
  /** The first row, or null. */
  getFirstAsync(): Promise<T | null>;
  /** Every row. */
  getAllAsync(): Promise<T[]>;
  /** Rewind to the first row. */
  resetAsync(): Promise<void>;
}

/** Whether a statement returns rows (it is run as a query, else as a write). */
function returnsRows(sql: string): boolean {
  return /^\s*(?:select|pragma|with|values|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

/** A result over rows already fetched. */
function executeResult<T>(
  rows: T[],
  run: { changes: number; lastInsertRowId: number },
): SQLiteExecuteAsyncResult<T> {
  let i = 0;
  const result: SQLiteExecuteAsyncResult<T> = {
    lastInsertRowId: run.lastInsertRowId,
    changes: run.changes,
    next(): Promise<IteratorResult<T>> {
      return Promise.resolve(
        i < rows.length ? { value: rows[i++], done: false } : { value: undefined, done: true },
      );
    },
    getFirstAsync: () => Promise.resolve(rows[0] ?? null),
    getAllAsync: () => Promise.resolve(rows.slice(i)),
    resetAsync() {
      i = 0;
      return Promise.resolve();
    },
    [Symbol.asyncIterator]() {
      return result;
    },
  };
  return result;
}

/** A prepared statement ({@linkcode SQLiteDatabase.prepareAsync}): the SQL, run on demand. */
export class SQLiteStatement {
  readonly #db: SQLiteDatabase;
  readonly #sql: string;
  #finalized = false;
  /** The params of the last run (the native column-name lookup reuses them). */
  #lastParams: SqliteParams = [];

  /** @internal Use {@linkcode SQLiteDatabase.prepareAsync}. */
  constructor(db: SQLiteDatabase, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  #check(): void {
    if (this.#finalized) throw new Error("SQLiteStatement: the statement is finalized");
  }

  /**
   * Run the statement with `params`.
   *
   * @param params The parameters (one array or record, or spread).
   * @returns The result: iterate it, or read its first / all rows.
   */
  async executeAsync<T>(...params: unknown[]): Promise<SQLiteExecuteAsyncResult<T>> {
    this.#check();
    const bind = this.#lastParams = paramsOf(params);
    if (returnsRows(this.#sql)) {
      const rows = objects<T>(await this.#db._rows(this.#sql, bind));
      return executeResult(rows, { changes: 0, lastInsertRowId: 0 });
    }
    return executeResult<T>([], await this.#db.runAsync(this.#sql, bind as SQLiteBindParams));
  }

  /**
   * Run the statement, rows as value arrays in column order.
   *
   * @param params The parameters (one array or record, or spread).
   * @returns The result over value arrays.
   */
  async executeForRawResultAsync<T extends object>(
    ...params: unknown[]
  ): Promise<SQLiteExecuteAsyncResult<T[keyof T][]>> {
    this.#check();
    const { rows } = await this.#db._rows(this.#sql, this.#lastParams = paramsOf(params));
    return executeResult(rows as T[keyof T][][], { changes: 0, lastInsertRowId: 0 });
  }

  /**
   * The statement's result column names.
   *
   * @returns The names (empty for a statement that returns no rows).
   */
  async getColumnNamesAsync(): Promise<string[]> {
    this.#check();
    if (!returnsRows(this.#sql)) return [];
    // The web engine names the columns of an empty result; the native plugin reports rows
    // only, so there the names come from a row of the statement run with its last params.
    const wrapped = `SELECT * FROM (${this.#sql.replace(/;\s*$/, "")}) LIMIT 0`;
    const empty = await this.#db._rows(wrapped, this.#lastParams).catch(() => null);
    if (empty && empty.columns.length > 0) return empty.columns;
    return (await this.#db._rows(this.#sql, this.#lastParams)).columns;
  }

  /**
   * Release the statement. Later runs throw.
   *
   * @returns A promise that settles at once.
   */
  finalizeAsync(): Promise<void> {
    this.#finalized = true;
    return Promise.resolve();
  }
}

/** A tagged-template query ({@linkcode SQLiteDatabase.sql}): awaitable, or read as values / first / each. */
export class SQLiteTaggedQuery<T = unknown> implements PromiseLike<T[] | SQLiteRunResult> {
  readonly #db: SQLiteDatabase;
  readonly #source: string;
  readonly #params: SQLiteBindValue[];

  /** @internal Use the database's `sql` tag. */
  constructor(db: SQLiteDatabase, strings: TemplateStringsArray, values: unknown[]) {
    this.#db = db;
    this.#source = strings.join("?");
    this.#params = values as SQLiteBindValue[];
  }

  /** Rows for a query, the run result for a write. */
  then<R1 = T[] | SQLiteRunResult, R2 = never>(
    onfulfilled?: ((value: T[] | SQLiteRunResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const result: Promise<T[] | SQLiteRunResult> = returnsRows(this.#source)
      ? this.#db.getAllAsync<T>(this.#source, this.#params)
      : this.#db.runAsync(this.#source, this.#params);
    return result.then(onfulfilled, onrejected);
  }

  /**
   * The rows as value arrays.
   *
   * @returns One array per row.
   */
  async values(): Promise<unknown[][]> {
    return (await this.#db._rows(this.#source, this.#params)).rows;
  }

  /**
   * The first row.
   *
   * @returns The row, or null.
   */
  first(): Promise<T | null> {
    return this.#db.getFirstAsync<T>(this.#source, this.#params);
  }

  /**
   * The rows one at a time.
   *
   * @returns An async iterator over the rows.
   */
  each(): AsyncIterableIterator<T> {
    return this.#db.getEachAsync<T>(this.#source, this.#params);
  }
}

/** An open database ({@linkcode openDatabaseAsync}). */
export class SQLiteDatabase {
  /** The name it was opened with. */
  readonly databasePath: string;
  /** The options it was opened with. */
  readonly options: SQLiteOpenOptions;
  /** Expo's native handle; there is none here. */
  readonly nativeDatabase: null = null;
  readonly #db: SqliteDatabase;
  readonly #lock: Lock;
  /** Inside an exclusive transaction's task: skip the lock that task holds. */
  readonly #holdsLock: boolean;

  /** @internal Use {@linkcode openDatabaseAsync}. */
  constructor(
    databasePath: string,
    options: SQLiteOpenOptions,
    db: SqliteDatabase,
    lock: Lock = new Lock(),
    holdsLock = false,
  ) {
    this.databasePath = databasePath;
    this.options = options;
    this.#db = db;
    this.#lock = lock;
    this.#holdsLock = holdsLock;
  }

  /** Run `fn` in turn with any exclusive transaction. */
  #turn<T>(fn: () => Promise<T>): Promise<T> {
    return this.#holdsLock ? fn() : this.#lock.run(fn);
  }

  /** @internal Rows as columns + value arrays (the statement and tagged-query helpers). */
  _rows(source: string, params: SqliteParams): Promise<SqliteRows> {
    return this.#turn(() => this.#db.queryRows(source, params));
  }

  /**
   * Whether a transaction is open.
   *
   * @returns true inside `BEGIN` … `COMMIT`.
   */
  isInTransactionAsync(): Promise<boolean> {
    return this.#turn(() => this.#db.inTransaction());
  }

  /**
   * Close the database.
   *
   * @returns A promise that settles once closed.
   */
  closeAsync(): Promise<void> {
    return this.#turn(() => this.#db.close());
  }

  /**
   * Run one or more statements (no parameters, no results).
   *
   * @param source The SQL.
   * @returns A promise that settles once they ran.
   */
  execAsync(source: string): Promise<void> {
    return this.#turn(() => this.#db.exec(source));
  }

  /**
   * Prepare `source` for repeated runs.
   *
   * @param source One statement.
   * @returns The statement.
   */
  prepareAsync(source: string): Promise<SQLiteStatement> {
    return Promise.resolve(new SQLiteStatement(this, source));
  }

  /**
   * Run `task` inside `BEGIN` … `COMMIT`, rolling back when it throws. Other calls on the
   * database are not held off (use {@linkcode withExclusiveTransactionAsync} for that).
   *
   * @param task The work.
   * @returns A promise that settles once committed (or rejects after the rollback).
   */
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await this.execAsync("BEGIN");
    try {
      await task();
      await this.execAsync("COMMIT");
    } catch (err) {
      await this.execAsync("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  /**
   * Run `task` inside an exclusive transaction: only calls made through `txn` run until it
   * commits or rolls back; calls on this database wait.
   *
   * @param task The work, given the transaction's own handle.
   * @returns A promise that settles once committed (or rejects after the rollback).
   */
  withExclusiveTransactionAsync(task: (txn: SQLiteDatabase) => Promise<void>): Promise<void> {
    return this.#turn(async () => {
      const txn = new SQLiteDatabase(this.databasePath, this.options, this.#db, this.#lock, true);
      await this.#db.exec("BEGIN EXCLUSIVE");
      try {
        await task(txn);
        await this.#db.exec("COMMIT");
      } catch (err) {
        await this.#db.exec("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Run one statement and report what it changed.
   *
   * @param source The statement.
   * @param params Its parameters: one array or record, or spread.
   * @returns The changes and the last inserted rowid.
   */
  runAsync(source: string, params: SQLiteBindParams): Promise<SQLiteRunResult>;
  /**
   * Run one statement, its parameters spread as arguments.
   *
   * @param source The statement.
   * @param params Its parameters.
   * @returns The changes and the last inserted rowid.
   */
  runAsync(source: string, ...params: SQLiteVariadicBindParams): Promise<SQLiteRunResult>;
  runAsync(source: string, ...params: unknown[]): Promise<SQLiteRunResult> {
    const bind = paramsOf(params);
    return this.#turn(async () => {
      const { changes, lastInsertRowId } = await this.#db.run(source, bind);
      return { changes, lastInsertRowId };
    });
  }

  /**
   * The first row of a query.
   *
   * @param source The statement.
   * @param params Its parameters: one array or record, or spread.
   * @returns The row, or null.
   */
  getFirstAsync<T>(source: string, params: SQLiteBindParams): Promise<T | null>;
  /**
   * The first row of a query, its parameters spread as arguments.
   *
   * @param source The statement.
   * @param params Its parameters.
   * @returns The row, or null.
   */
  getFirstAsync<T>(source: string, ...params: SQLiteVariadicBindParams): Promise<T | null>;
  async getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null> {
    const rows = objects<T>(await this._rows(source, paramsOf(params)));
    return rows[0] ?? null;
  }

  /**
   * The rows of a query, one at a time.
   *
   * @param source The statement.
   * @param params Its parameters: one array or record, or spread.
   * @returns An async iterator over the rows.
   */
  getEachAsync<T>(source: string, params: SQLiteBindParams): AsyncIterableIterator<T>;
  /**
   * The rows of a query one at a time, its parameters spread as arguments.
   *
   * @param source The statement.
   * @param params Its parameters.
   * @returns An async iterator over the rows.
   */
  getEachAsync<T>(source: string, ...params: SQLiteVariadicBindParams): AsyncIterableIterator<T>;
  getEachAsync<T>(source: string, ...params: unknown[]): AsyncIterableIterator<T> {
    const bind = paramsOf(params);
    return rowIterator(async () => objects<T>(await this._rows(source, bind)));
  }

  /**
   * Every row of a query.
   *
   * @param source The statement.
   * @param params Its parameters: one array or record, or spread.
   * @returns The rows.
   */
  getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>;
  /**
   * Every row of a query, its parameters spread as arguments.
   *
   * @param source The statement.
   * @param params Its parameters.
   * @returns The rows.
   */
  getAllAsync<T>(source: string, ...params: SQLiteVariadicBindParams): Promise<T[]>;
  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    return objects<T>(await this._rows(source, paramsOf(params)));
  }

  /**
   * A tagged-template query: `` await db.sql`SELECT * FROM t WHERE id = ${id}` ``. Each
   * interpolated value binds as a parameter.
   */
  sql = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SQLiteTaggedQuery<T> =>
    new SQLiteTaggedQuery<T>(this, strings, values);
}

/**
 * Open (creating when missing) the database `databaseName`.
 *
 * @param databaseName The database file name.
 * @param options Accepted; none changes the behaviour here.
 * @param directory Accepted and ignored: the backing decides where databases live.
 * @returns The open database.
 */
export async function openDatabaseAsync(
  databaseName: string,
  options?: SQLiteOpenOptions,
  directory?: string,
): Promise<SQLiteDatabase> {
  void directory;
  return new SQLiteDatabase(databaseName, options ?? {}, await openSqlite(databaseName));
}

/**
 * Delete the database `databaseName`.
 *
 * @param databaseName The database file name.
 * @param directory Accepted and ignored.
 * @returns A promise that settles once deleted.
 */
export async function deleteDatabaseAsync(databaseName: string, directory?: string): Promise<void> {
  void directory;
  await deleteSqlite(databaseName);
}

/** The context {@linkcode SQLiteProvider} fills. */
const SQLiteContext = createContext<SQLiteDatabase | null>(null);

/** Props of {@linkcode SQLiteProvider}. */
export interface SQLiteProviderProps {
  /** The database to open. */
  databaseName: string;
  /** Accepted and ignored. */
  directory?: string;
  /** Open options. */
  options?: SQLiteOpenOptions;
  /** A bundled database to copy in first (not provided here: passing one reports an error). */
  assetSource?: { assetId: number; forceOverwrite?: boolean };
  /** The subtree that uses the database. */
  children?: unknown;
  /** Run once the database is open, before the children render. */
  onInit?: (db: SQLiteDatabase) => Promise<void>;
  /** Called when opening or `onInit` fails (default: rethrow into the tree). */
  onError?: (error: Error) => void;
  /** Accepted; the children render once the database is ready either way. */
  useSuspense?: boolean;
}

/**
 * Open `databaseName`, run `onInit`, then render `children` with the database available
 * through {@linkcode useSQLiteContext}. Nothing renders until it is ready.
 *
 * @param props The database and its children.
 * @returns The provider.
 */
export function SQLiteProvider(props: SQLiteProviderProps): VNode | null {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const { databaseName, assetSource } = props;
  useEffect(() => {
    let cancelled = false;
    let opened: SQLiteDatabase | null = null;
    (async () => {
      if (assetSource) {
        throw new Error("SQLiteProvider: assetSource is not supported by denext's expo-sqlite");
      }
      opened = await openDatabaseAsync(databaseName, props.options);
      await props.onInit?.(opened);
      if (!cancelled) setDb(opened);
    })().catch((err) => {
      if (cancelled) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (props.onError) props.onError(e);
      else setError(e);
    });
    return () => {
      cancelled = true;
      void opened?.closeAsync().catch(() => {});
    };
  }, [databaseName]);
  if (error) throw error;
  if (!db) return null;
  return h(SQLiteContext.Provider, { value: db }, props.children as VNode);
}

/**
 * The database of the nearest {@linkcode SQLiteProvider}.
 *
 * @returns The database.
 */
export function useSQLiteContext(): SQLiteDatabase {
  const db = useContext(SQLiteContext);
  if (!db) throw new Error("useSQLiteContext must be used within a <SQLiteProvider>");
  return db;
}

/**
 * Whether two objects are deeply equal (own enumerable keys, recursively), as expo-sqlite's
 * provider compares its options.
 *
 * @param a One object.
 * @param b The other.
 * @returns Whether they are equal.
 */
export function deepEqual(
  a: { [key: string]: unknown } | undefined,
  b: { [key: string]: unknown } | undefined,
): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) =>
      deepEqual(a[key] as { [key: string]: unknown }, b[key] as { [key: string]: unknown })
    );
}
