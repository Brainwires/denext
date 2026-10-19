/**
 * The slice of `Deno.SQL` the Prisma adapter drives, restated structurally: the result-set
 * column metadata (`result.columns`) first shipped in denext's runtime 2.9.7-denext.23, so
 * the runtime type declarations of older toolchains do not have it.
 *
 * @module
 */

/** A result column as `Deno.SQL` describes it (both drivers' fields; see `Deno.SQLColumn`). */
export interface SqlColumn {
  /** The column's name in the result. */
  name: string;
  /** Postgres: `pg_type.typname` (`"int4"`, `"_int4"`, an enum's name). SQLite: the declared type. */
  type: string | null;
  /** Postgres only: the type's OID. */
  typeOid?: number;
  /** Postgres only: what kind of type it is. */
  typeKind?:
    | "simple"
    | "array"
    | "enum"
    | "domain"
    | "composite"
    | "range"
    | "multirange"
    | "pseudo"
    | null;
  /** Postgres only: an array's element type, a domain's underlying type. */
  baseType?: string | null;
  /** Postgres only: the OID of `baseType`. */
  baseTypeOid?: number | null;
}

/** Rows plus what the database reported about them. */
export interface SqlRows<T> extends Array<T> {
  /** Rows affected (INSERT / UPDATE / DELETE) or returned (SELECT). */
  count: number;
  /** The statement's command (`"SELECT"`, `"INSERT"`, …). */
  command?: string;
  /** The result's columns, in order (runtime 2.9.7-denext.23 and later). */
  columns?: SqlColumn[];
  /** SQLite: the rowid of the last inserted row. */
  lastInsertRowid?: number | bigint;
}

/** A `Deno.SQL` query: awaited for its rows, or switched to another row form first. */
export interface SqlRequest<T = Record<string, unknown>> extends PromiseLike<SqlRows<T>> {
  /** Rows as arrays of values. */
  values(): SqlRequest<unknown[]>;
  /** Rows as arrays of each value's raw (binary, on Postgres) bytes. */
  raw(): SqlRequest<(Uint8Array | null)[]>;
  /** The simple query protocol: several statements, no parameters. */
  simple(): SqlRequest<T>;
}

/** A `Deno.SQL` client (or one of its reserved connections). */
export interface DenoSqlClient {
  /** A query from raw text with `$1`… (Postgres) or `?` (SQLite) parameters. */
  unsafe(text: string, params?: unknown[]): SqlRequest;
  /** A pooled connection for this caller alone, until `release()`. */
  reserve(): Promise<DenoSqlClient>;
  /** Return a reserved connection to the pool. */
  release(): void;
  /** Close every connection. */
  close(options?: { timeout?: number }): Promise<void>;
  /** The resolved options (without the password). */
  readonly options?: Record<string, unknown>;
}

/** The options `new Deno.SQL(url, options)` takes that the adapter sets. */
export interface DenoSqlOptions {
  /** `"postgres"` or `"sqlite"`. */
  adapter?: "postgres" | "sqlite";
  /** Most connections in the pool. */
  max?: number;
  /** Give up connecting after this many seconds. */
  connectionTimeout?: number;
  /** Keep prepared statements per connection (`false` for transaction-mode poolers). */
  prepare?: boolean;
  /** 64-bit integers as `bigint`. */
  bigint?: boolean;
  /** Postgres run-time parameters sent at connection start (`search_path`). */
  connection?: Record<string, string>;
  /** TLS settings. */
  tls?: boolean | { rejectUnauthorized?: boolean };
  /** Anything else `Deno.SQL` takes, passed through. */
  [key: string]: unknown;
}

/** The `Deno.SQL` constructor. */
export type DenoSqlConstructor = new (url: string, options?: DenoSqlOptions) => DenoSqlClient;

/** The runtime's `Deno.SQL` constructor, or `undefined` on a Deno without one. */
export function denoSqlConstructor(): DenoSqlConstructor | undefined {
  const ctor = (Deno as unknown as { SQL?: unknown }).SQL;
  return typeof ctor === "function" ? ctor as DenoSqlConstructor : undefined;
}

/**
 * Whether this runtime's `Deno.SQL` reports result-set column metadata (`result.columns`),
 * which the Prisma adapter needs: denext's Deno runtime 2.9.7-denext.23 and later. Probes an
 * in-memory SQLite database, so it needs no permission and touches no file.
 */
export async function denoSqlHasColumns(): Promise<boolean> {
  const SQL = denoSqlConstructor();
  if (!SQL) return false;
  let sql: DenoSqlClient | undefined;
  try {
    sql = new SQL(":memory:", { adapter: "sqlite" });
    const rows = await sql.unsafe("select 1 as probe").values();
    return Array.isArray(rows.columns) && rows.columns[0]?.name === "probe";
  } catch {
    return false;
  } finally {
    await sql?.close().catch(() => {});
  }
}
