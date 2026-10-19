/**
 * The Prisma driver adapter over a `Deno.SQL` client: the queryable, its transactions and the
 * connected adapter, each delegating the database specifics to a {@linkcode Driver}.
 *
 * @module
 */

import type { DenoSqlClient, SqlColumn, SqlRows } from "./client.ts";
import * as pg from "./postgres.ts";
import * as lite from "./sqlite.ts";
import {
  type AdapterError,
  type ConnectionInfo,
  DriverAdapterError,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
  type Transaction,
} from "./types.ts";

/** The `adapterName` Prisma sees. */
export const ADAPTER_NAME = "denext/prisma-adapter";

/** One database's side of the adapter. */
export interface Driver {
  /** `"postgres"` or `"sqlite"`. */
  readonly provider: "postgres" | "sqlite";
  /** Prisma's arguments in the form `Deno.SQL` binds. */
  args(query: SqlQuery): unknown[];
  /** Run a query on `conn` and read its result. */
  query(conn: DenoSqlClient, query: SqlQuery): Promise<SqlResultSet>;
  /** A database error as Prisma's, or null to pass it on as is. */
  convertError(error: unknown): AdapterError | null;
  /** The isolation levels a transaction may ask for. */
  readonly isolationLevels: ReadonlySet<IsolationLevel>;
  /** What Prisma learns about the connection. */
  readonly connectionInfo: ConnectionInfo;
}

/**
 * The columns of a result: `Deno.SQL`'s `result.columns`, which the adapter needs.
 *
 * @throws {Error} On a runtime before 2.9.7-denext.23, whose results have none.
 */
export function resultColumns(rows: SqlRows<unknown>): SqlColumn[] {
  if (!Array.isArray(rows.columns)) {
    throw new Error(
      "denext/prisma-adapter: this Deno.SQL reports no result-set columns (result.columns) — " +
        "the Prisma adapter needs denext's Deno runtime 2.9.7-denext.23 or later.",
    );
  }
  return rows.columns;
}

/** The Postgres driver; `kinds` caches `pg_type.typtype` of user types. */
export function postgresDriver(schema: string | undefined): Driver {
  const kinds = new Map<number, string | null>();
  return {
    provider: "postgres",
    args: (q) => q.args.map((arg, i) => pg.mapPostgresArg(arg, q.argTypes[i] ?? UNKNOWN_ARG)),
    async query(conn, q) {
      const rows = await conn.unsafe(q.sql, this.args(q)).raw();
      const columns = resultColumns(rows);
      const kindOf = async (oid: number) => {
        if (!kinds.has(oid)) {
          const r = await conn.unsafe("select typtype::text from pg_type where oid = $1", [oid])
            .values();
          kinds.set(oid, (r[0]?.[0] as string | undefined) ?? null);
        }
        return kinds.get(oid) ?? null;
      };
      const codecs: pg.Codec[] = [];
      for (const column of columns) codecs.push(await pg.columnCodec(column, kindOf));
      return {
        columnNames: columns.map((c) => c.name),
        columnTypes: codecs.map((c) => c.type),
        rows: rows.map((row) => row.map((b, i) => (b === null ? null : codecs[i].decode(b)))),
      };
    },
    convertError: pg.convertPostgresError,
    isolationLevels: new Set([
      "READ UNCOMMITTED",
      "READ COMMITTED",
      "REPEATABLE READ",
      "SERIALIZABLE",
    ]),
    connectionInfo: { schemaName: schema, supportsRelationJoins: true },
  };
}

/** The SQLite driver, storing `DateTime` arguments in `timestampFormat`. */
export function sqliteDriver(timestampFormat: lite.TimestampFormat): Driver {
  return {
    provider: "sqlite",
    args: (q) =>
      q.args.map((arg, i) => lite.mapSqliteArg(arg, q.argTypes[i] ?? UNKNOWN_ARG, timestampFormat)),
    async query(conn, q) {
      const rows = await conn.unsafe(q.sql, this.args(q)).values();
      const columns = resultColumns(rows);
      const types = lite.columnTypes(columns, rows);
      const result: SqlResultSet = {
        columnNames: columns.map((c) => c.name),
        columnTypes: types,
        rows: rows.map((row) => lite.mapRow(row, types)),
      };
      if (rows.command === "INSERT" && rows.lastInsertRowid != null) {
        result.lastInsertId = String(rows.lastInsertRowid);
      }
      return result;
    },
    convertError: lite.convertSqliteError,
    isolationLevels: new Set(["SERIALIZABLE"]),
    connectionInfo: { supportsRelationJoins: false },
  };
}

const UNKNOWN_ARG = { scalarType: "unknown", arity: "scalar" } as const;

/** Queries on one `Deno.SQL` connection (the pool, or a transaction's reserved connection). */
class DenoSqlQueryable implements SqlQueryable {
  readonly adapterName = ADAPTER_NAME;
  readonly provider: "postgres" | "sqlite";

  constructor(protected readonly conn: DenoSqlClient, protected readonly driver: Driver) {
    this.provider = driver.provider;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    try {
      return await this.driver.query(this.conn, query);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    try {
      return (await this.conn.unsafe(query.sql, this.driver.args(query))).count;
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** `error` as a {@linkcode DriverAdapterError} when it is the database's, else as is. */
  protected mapError(error: unknown): unknown {
    const mapped = this.driver.convertError(error);
    return mapped ? new DriverAdapterError(mapped) : error;
  }
}

const FINISH = /^\s*(COMMIT|ROLLBACK)\b/i;

/**
 * A transaction on a reserved connection. Prisma sends BEGIN's COMMIT / ROLLBACK itself and
 * then calls `commit()` / `rollback()`, which return the connection to the pool; a COMMIT or
 * ROLLBACK that fails rolls back and returns it too, so no connection is held after an error.
 */
class DenoSqlTransaction extends DenoSqlQueryable implements Transaction {
  readonly options = { usePhantomQuery: false };
  #released = false;

  override async executeRaw(query: SqlQuery): Promise<number> {
    try {
      return await super.executeRaw(query);
    } catch (error) {
      if (FINISH.test(query.sql)) {
        await this.conn.unsafe("ROLLBACK").then(() => {}, () => {});
        this.#release();
      }
      throw error;
    }
  }

  commit(): Promise<void> {
    this.#release();
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.#release();
    return Promise.resolve();
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.conn.release();
  }
}

/** The connected adapter: queries on the pool, transactions on reserved connections. */
export class DenoSqlAdapter extends DenoSqlQueryable implements SqlDriverAdapter {
  readonly #dispose: () => Promise<void>;

  constructor(client: DenoSqlClient, driver: Driver, dispose: () => Promise<void>) {
    super(client, driver);
    this.#dispose = dispose;
  }

  async executeScript(script: string): Promise<void> {
    try {
      await this.conn.unsafe(script).simple();
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel && !this.driver.isolationLevels.has(isolationLevel)) {
      throw new DriverAdapterError({ kind: "InvalidIsolationLevel", level: isolationLevel });
    }
    let conn: DenoSqlClient;
    try {
      conn = await this.conn.reserve();
    } catch (error) {
      throw this.mapError(error);
    }
    try {
      await conn.unsafe("BEGIN");
      if (isolationLevel && this.provider === "postgres") {
        await conn.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
    } catch (error) {
      await conn.unsafe("ROLLBACK").then(() => {}, () => {});
      conn.release();
      throw this.mapError(error);
    }
    return new DenoSqlTransaction(conn, this.driver);
  }

  getConnectionInfo(): ConnectionInfo {
    return this.driver.connectionInfo;
  }

  dispose(): Promise<void> {
    return this.#dispose();
  }
}
