/**
 * SQLite specifics of the Prisma adapter: each result column's Prisma type from its declared
 * type (`Deno.SQL`'s column metadata), else from the values; rows and arguments in the forms
 * Prisma and SQLite take; SQLite errors as Prisma's error kinds. It reads values as
 * `@prisma/adapter-better-sqlite3` does.
 *
 * @module
 */

import type { SqlColumn } from "./client.ts";
import {
  type AdapterError,
  type ArgType,
  type ColumnType,
  ColumnTypeEnum as T,
  type MappedError,
} from "./types.ts";
import { base64Bytes, errorFields } from "./shared.ts";

/** How a `DateTime` argument is stored. */
export type TimestampFormat = "iso8601" | "unixepoch-ms";

const DECLARED: Record<string, ColumnType> = {
  DECIMAL: T.Numeric,
  FLOAT: T.Float,
  DOUBLE: T.Double,
  "DOUBLE PRECISION": T.Double,
  NUMERIC: T.Double,
  REAL: T.Double,
  TINYINT: T.Int32,
  SMALLINT: T.Int32,
  MEDIUMINT: T.Int32,
  INT: T.Int32,
  INTEGER: T.Int32,
  SERIAL: T.Int32,
  INT2: T.Int32,
  BIGINT: T.Int64,
  "UNSIGNED BIG INT": T.Int64,
  INT8: T.Int64,
  DATETIME: T.DateTime,
  TIMESTAMP: T.DateTime,
  TIME: T.Time,
  DATE: T.Date,
  TEXT: T.Text,
  CLOB: T.Text,
  CHARACTER: T.Text,
  VARCHAR: T.Text,
  "VARYING CHARACTER": T.Text,
  NCHAR: T.Text,
  "NATIVE CHARACTER": T.Text,
  NVARCHAR: T.Text,
  BLOB: T.Bytes,
  BOOLEAN: T.Boolean,
  JSONB: T.Json,
};

/** The Prisma type of a declared column type (`varchar(20)` reads as `VARCHAR`), or null. */
export function declaredType(declared: string | null): ColumnType | null {
  if (!declared) return null;
  const name = declared.replace(/\(.*$/, "").trim().toUpperCase();
  return DECLARED[name] ?? null;
}

/** The Prisma type of a value from a column with no (known) declared type. */
function inferredType(value: unknown): ColumnType {
  switch (typeof value) {
    case "string":
      return T.Text;
    case "bigint":
      return T.Int64;
    case "boolean":
      return T.Boolean;
    case "number":
      return T.UnknownNumber;
    default:
      if (value instanceof Uint8Array) return T.Bytes;
      throw new TypeError(`unexpected SQLite value of type ${typeof value}`);
  }
}

/**
 * Each column's Prisma type: its declared type, else the type of its first non-null value
 * (`Int32` when every value is null), as Prisma's SQLite adapters decide it.
 */
export function columnTypes(
  columns: readonly SqlColumn[],
  rows: readonly unknown[][],
): ColumnType[] {
  return columns.map((column, i) => {
    const declared = declaredType(column.type);
    if (declared !== null) return declared;
    const sample = rows.find((row) => row[i] !== null && row[i] !== undefined)?.[i];
    return sample === undefined ? T.Int32 : inferredType(sample);
  });
}

/**
 * A 64-bit integer (the adapter's client reads every integer as a `bigint`, as Prisma's
 * better-sqlite3 adapter does): a string for an `Int64` column or beyond 2^53, else a number.
 */
function bigintValue(value: bigint, type: ColumnType): number | string {
  const safe = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER);
  return type !== T.Int64 && safe ? Number(value) : value.toString();
}

/** A number (or `bigint`) as Prisma reads it from a column of `type`. */
function numericValue(value: number | bigint, type: ColumnType): unknown {
  if (type === T.DateTime) return new Date(Number(value)).toISOString();
  if (typeof value === "bigint") return bigintValue(value, type);
  const integral = type === T.Int32 || type === T.Int64;
  return integral && !Number.isInteger(value) ? Math.trunc(value) : value;
}

/** One value as Prisma reads it from a column of `type`. */
function mapValue(value: unknown, type: ColumnType): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === "number" || typeof value === "bigint") return numericValue(value, type);
  return value ?? null;
}

/** A row's values as Prisma reads them: bytes as number arrays, `Int64`s as strings. */
export function mapRow(row: readonly unknown[], types: readonly ColumnType[]): unknown[] {
  return row.map((value, i) => mapValue(value, types[i]));
}

/** A string argument of a numeric scalar type, as the number SQLite compares it as. */
function numericArg(arg: string, scalarType: ArgType["scalarType"]): unknown {
  switch (scalarType) {
    case "int":
      return Number.parseInt(arg);
    case "float":
    case "decimal":
      return Number.parseFloat(arg);
    case "bigint":
      return BigInt(arg);
    default:
      return arg;
  }
}

/** A `Date` as stored: ISO 8601 text (`…+00:00`), or milliseconds since the epoch. */
function dateArg(value: Date, format: TimestampFormat): unknown {
  return format === "unixepoch-ms" ? value.getTime() : value.toISOString().replace("Z", "+00:00");
}

/**
 * One Prisma argument in the form `Deno.SQL` binds for SQLite: numeric strings as numbers,
 * booleans as 1 / 0, datetimes in `timestampFormat`, bytes as a `Uint8Array`.
 */
export function mapSqliteArg(
  arg: unknown,
  argType: ArgType,
  timestampFormat: TimestampFormat,
): unknown {
  if (arg === null || arg === undefined) return null;
  if (typeof arg === "boolean") return arg ? 1 : 0;
  if (typeof arg === "string" && argType.scalarType === "datetime") {
    return dateArg(new Date(arg), timestampFormat);
  }
  if (arg instanceof Date) return dateArg(arg, timestampFormat);
  if (typeof arg === "string") {
    return argType.scalarType === "bytes" ? base64Bytes(arg) : numericArg(arg, argType.scalarType);
  }
  if (Array.isArray(arg) && argType.scalarType === "bytes") return Uint8Array.from(arg as number[]);
  return arg;
}

/** The columns named after `constraint failed: ` (`User.email, User.name` → `email`, `name`). */
function failedFields(message: string): { fields: string[] } | undefined {
  const list = message.split("constraint failed: ")[1];
  return list ? { fields: list.split(", ").map((f) => f.split(".").pop()!) } : undefined;
}

/**
 * A unique / primary-key violation as `@prisma/adapter-better-sqlite3` reports it: the fields,
 * and the table from the first `<table>.<column>` of `UNIQUE constraint failed: …`.
 */
function uniqueViolation(message: string): MappedError {
  const first = message.split("constraint failed: ")[1]?.split(", ")[0];
  const table = first?.split(".").slice(0, -1).join(".") || undefined;
  return {
    kind: "UniqueConstraintViolation",
    constraint: failedFields(message),
    ...(table !== undefined && { table }),
  };
}

/** Prisma's error kind for each SQLite code it has one for. */
const SQLITE_ERRORS: Record<string, (message: string) => MappedError> = {
  SQLITE_BUSY: () => ({ kind: "SocketTimeout" }),
  ERR_SQLITE_CONNECTION_TIMEOUT: () => ({ kind: "SocketTimeout" }),
  SQLITE_CONSTRAINT_UNIQUE: uniqueViolation,
  SQLITE_CONSTRAINT_PRIMARYKEY: uniqueViolation,
  SQLITE_CONSTRAINT_NOTNULL: (m) => ({
    kind: "NullConstraintViolation",
    constraint: failedFields(m),
  }),
  SQLITE_CONSTRAINT_FOREIGNKEY: () => FOREIGN_KEY,
  SQLITE_CONSTRAINT_TRIGGER: () => FOREIGN_KEY,
};
const FOREIGN_KEY: MappedError = {
  kind: "ForeignKeyConstraintViolation",
  constraint: { foreignKey: {} },
};

/** A missing table or column named in a SQLite message. */
function missingObject(message: string): MappedError | null {
  const table = /^no such table: (\S+)/.exec(message)?.[1];
  if (table) return { kind: "TableDoesNotExist", table };
  const column = /^no such column: (\S+)/.exec(message)?.[1] ??
    /has no column named (\S+)/.exec(message)?.[1];
  return column ? { kind: "ColumnNotFound", column } : null;
}

/** A SQLite error (an `SQLITE_*` code) as Prisma's error kind. */
function sqliteError(code: string, message: string, errno: unknown): MappedError | null {
  const mapped = SQLITE_ERRORS[code]?.(message) ?? missingObject(message);
  if (mapped) return mapped;
  return typeof errno === "number" ? { kind: "sqlite", extendedCode: errno, message } : null;
}

/**
 * A `Deno.SQL` SQLite error as Prisma's error, or null for an error that is not the
 * database's (Prisma then reports it as is).
 */
export function convertSqliteError(error: unknown): AdapterError | null {
  const fields = errorFields(error);
  if (!fields) return null;
  const mapped = sqliteError(fields.code, fields.message, fields.e.errno);
  return mapped && { originalCode: fields.code, originalMessage: fields.message, ...mapped };
}
