/**
 * The Prisma driver-adapter contract, restated structurally so the adapter imports nothing
 * from npm at run time (or type-check time). These shapes match
 * `@prisma/driver-adapter-utils` 6.19.3 — `tests/prisma-adapter-types.test.ts` checks them
 * against the real package in both directions, so a Prisma release that changes the contract
 * fails a test instead of a query.
 *
 * @module
 */

/** Prisma's `ColumnTypeEnum`: the type tag a result column reports for each value. */
export const ColumnTypeEnum = {
  Int32: 0,
  Int64: 1,
  Float: 2,
  Double: 3,
  Numeric: 4,
  Boolean: 5,
  Character: 6,
  Text: 7,
  Date: 8,
  Time: 9,
  DateTime: 10,
  Json: 11,
  Enum: 12,
  Bytes: 13,
  Set: 14,
  Uuid: 15,
  Int32Array: 64,
  Int64Array: 65,
  FloatArray: 66,
  DoubleArray: 67,
  NumericArray: 68,
  BooleanArray: 69,
  CharacterArray: 70,
  TextArray: 71,
  DateArray: 72,
  TimeArray: 73,
  DateTimeArray: 74,
  JsonArray: 75,
  EnumArray: 76,
  BytesArray: 77,
  UuidArray: 78,
  UnknownNumber: 128,
} as const;

/** One of {@linkcode ColumnTypeEnum}'s values. */
export type ColumnType = (typeof ColumnTypeEnum)[keyof typeof ColumnTypeEnum];

/** The scalar type Prisma declares for a query argument. */
export type ArgScalarType =
  | "string"
  | "int"
  | "bigint"
  | "float"
  | "decimal"
  | "boolean"
  | "enum"
  | "uuid"
  | "json"
  | "datetime"
  | "bytes"
  | "unknown";

/** What Prisma knows about a query argument: its scalar type, native type and arity. */
export interface ArgType {
  /** The argument's scalar type. */
  scalarType: ArgScalarType;
  /** The column's native type, when the schema names one (`"DATE"`, `"TIME"`, …). */
  dbType?: string;
  /** `"list"` for an array argument. */
  arity: "scalar" | "list";
}

/** A query Prisma sends: SQL text with positional parameters and their types. */
export interface SqlQuery {
  /** The SQL text (`$1`… placeholders on Postgres, `?` on SQLite). */
  sql: string;
  /** The parameter values. */
  args: Array<unknown>;
  /** The parameters' types, one per argument. */
  argTypes: Array<ArgType>;
}

/** A query's result, in the shape Prisma's query engine reads. */
export interface SqlResultSet {
  /** One {@linkcode ColumnType} per column, in `columnNames` order. */
  columnTypes: Array<ColumnType>;
  /** The column names. */
  columnNames: Array<string>;
  /** The rows, each a list of values in column order. */
  rows: Array<Array<unknown>>;
  /** The rowid of the last inserted row (SQLite), as a string. */
  lastInsertId?: string;
}

/** The transaction isolation levels Prisma may ask for. */
export type IsolationLevel =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SNAPSHOT"
  | "SERIALIZABLE";

/** The databases a Prisma driver adapter may speak to. */
export type Provider = "mysql" | "postgres" | "sqlite" | "sqlserver";

/** A constraint a database error names (fields, an index, or a foreign key). */
// deno-lint-ignore ban-types -- `{}` is Prisma's own spelling; the contract test compares exactly
export type ErrorConstraint = { fields: string[] } | { index: string } | { foreignKey: {} };

/**
 * A database error in the form Prisma turns into its own `P20xx` errors. Each `kind` is one
 * Prisma knows; `postgres` / `sqlite` carry an error it has no dedicated kind for.
 */
export type MappedError =
  | { kind: "GenericJs"; id: number }
  | { kind: "UnsupportedNativeDataType"; type: string }
  | { kind: "InvalidIsolationLevel"; level: string }
  | { kind: "LengthMismatch"; column?: string }
  | { kind: "UniqueConstraintViolation"; constraint?: ErrorConstraint }
  | { kind: "NullConstraintViolation"; constraint?: ErrorConstraint }
  | { kind: "ForeignKeyConstraintViolation"; constraint?: ErrorConstraint }
  | { kind: "DatabaseNotReachable"; host?: string; port?: number }
  | { kind: "DatabaseDoesNotExist"; db?: string }
  | { kind: "DatabaseAlreadyExists"; db?: string }
  | { kind: "DatabaseAccessDenied"; db?: string }
  | { kind: "ConnectionClosed" }
  | { kind: "TlsConnectionError"; reason: string }
  | { kind: "AuthenticationFailed"; user?: string }
  | { kind: "TransactionWriteConflict" }
  | { kind: "TableDoesNotExist"; table?: string }
  | { kind: "ColumnNotFound"; column?: string }
  | { kind: "TooManyConnections"; cause: string }
  | { kind: "ValueOutOfRange"; cause: string }
  | { kind: "MissingFullTextSearchIndex" }
  | { kind: "SocketTimeout" }
  | { kind: "InconsistentColumnData"; cause: string }
  | { kind: "TransactionAlreadyClosed"; cause: string }
  | {
    kind: "postgres";
    code: string;
    severity: string;
    message: string;
    detail: string | undefined;
    column: string | undefined;
    hint: string | undefined;
  }
  | { kind: "mysql"; code: number; message: string; state: string }
  | { kind: "sqlite"; extendedCode: number; message: string }
  | { kind: "mssql"; code: number; message: string };

/** A {@linkcode MappedError} plus the driver's own code and message. */
export type AdapterError = MappedError & { originalCode?: string; originalMessage?: string };

/**
 * The error an adapter throws so Prisma reports a typed database error instead of a generic
 * one. Prisma recognizes it by `name` and `cause` (no `instanceof`), so this class needs no
 * import from Prisma.
 */
export class DriverAdapterError extends Error {
  /** Always `"DriverAdapterError"`: what Prisma checks. */
  override name = "DriverAdapterError";
  /** The mapped error. */
  override cause: AdapterError;
  /** Wrap a mapped error. */
  constructor(payload: AdapterError) {
    super(
      "message" in payload && typeof payload.message === "string" ? payload.message : payload.kind,
    );
    this.cause = payload;
  }
}

/** What Prisma learns about the connection. */
export interface ConnectionInfo {
  /** The schema queries run in (Postgres). */
  schemaName?: string;
  /** The most bind parameters one statement may take. */
  maxBindValues?: number;
  /** Whether relations may be loaded with joins in one query. */
  supportsRelationJoins: boolean;
}

/** Something that runs queries: an adapter or one of its transactions. */
export interface SqlQueryable {
  /** The database the adapter speaks to. */
  readonly provider: Provider;
  /** The adapter's package name. */
  readonly adapterName: string;
  /** Run a query and return its rows. */
  queryRaw(params: SqlQuery): Promise<SqlResultSet>;
  /** Run a statement and return the number of rows it affected. */
  executeRaw(params: SqlQuery): Promise<number>;
}

/** An open transaction. Prisma sends COMMIT / ROLLBACK itself, then calls `commit()` / `rollback()`. */
export interface Transaction extends SqlQueryable {
  /** Transaction options: `usePhantomQuery: false` means Prisma sends COMMIT / ROLLBACK. */
  readonly options: { usePhantomQuery: boolean };
  /** Finish after Prisma's COMMIT: release the connection. */
  commit(): Promise<void>;
  /** Finish after Prisma's ROLLBACK: release the connection. */
  rollback(): Promise<void>;
}

/** A connected driver adapter. */
export interface SqlDriverAdapter extends SqlQueryable {
  /** Run several statements separated by semicolons. */
  executeScript(script: string): Promise<void>;
  /** Begin a transaction, at `isolationLevel` when given. */
  startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction>;
  /** Extra connection facts for Prisma. */
  getConnectionInfo?(): ConnectionInfo;
  /** Close the connection (or pool) the adapter owns. */
  dispose(): Promise<void>;
}

/** The factory `new PrismaClient({ adapter })` takes. */
export interface SqlMigrationAwareDriverAdapterFactory {
  /** The database the adapter speaks to. */
  readonly provider: Provider;
  /** The adapter's package name. */
  readonly adapterName: string;
  /** Open a connected adapter. */
  connect(): Promise<SqlDriverAdapter>;
  /** Open an adapter on a throwaway shadow database (for migrations). */
  connectToShadowDb(): Promise<SqlDriverAdapter>;
}
