/**
 * Postgres specifics of the Prisma adapter: each result column's Prisma type and decoder from
 * `Deno.SQL`'s column metadata, Prisma's arguments in the form Postgres takes them, and
 * Postgres errors as Prisma's error kinds.
 *
 * @module
 */

import { type Codec, decodeArray, decodeText, moneyDecoder, SCALARS } from "./pg-binary.ts";
export type { Codec };
import type { SqlColumn } from "./client.ts";
import {
  type AdapterError,
  type ArgType,
  type ColumnType,
  ColumnTypeEnum as T,
  DriverAdapterError,
  type MappedError,
} from "./types.ts";
import {
  base64Bytes,
  errorFields,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcTime,
} from "./shared.ts";

/** `pg_type.typtype` of a type OID (`"e"` for an enum), or null when unknown. */
export type TypeKindLookup = (oid: number) => Promise<string | null>;

/** The fractional digits of the server's `lc_monetary` (what a `money` value is counted in). */
export type MoneyScaleLookup = () => Promise<number>;

/** `money`'s type OID. */
const MONEY_OID = 790;

/**
 * A built-in scalar's codec: `money` read at the scale `moneyScale` reports (two digits without
 * one), any other from {@linkcode SCALARS}.
 */
async function builtinCodec(
  oid: number,
  moneyScale: MoneyScaleLookup | undefined,
): Promise<Codec | undefined> {
  if (oid === MONEY_OID && moneyScale) {
    return { type: T.Numeric, decode: moneyDecoder(await moneyScale()) };
  }
  return SCALARS.get(oid);
}

const ENUM_CODEC: Codec = { type: T.Enum, decode: decodeText };
const CITEXT_CODEC: Codec = { type: T.Text, decode: decodeText };

/** The error for a column type Prisma cannot read. */
function unsupported(type: string | null | undefined): DriverAdapterError {
  return new DriverAdapterError({ kind: "UnsupportedNativeDataType", type: type ?? "Unknown" });
}

/** The codec of a scalar type by OID: built in, an enum, or `citext`; else unsupported. */
async function scalarCodec(
  oid: number,
  name: string | null | undefined,
  kindOf: TypeKindLookup,
  moneyScale: MoneyScaleLookup | undefined,
): Promise<Codec> {
  const builtin = await builtinCodec(oid, moneyScale);
  if (builtin) return builtin;
  if (name === "citext") return CITEXT_CODEC;
  if (oid >= 16384 && (await kindOf(oid)) === "e") return ENUM_CODEC;
  throw unsupported(name);
}

/**
 * The array form of an element type: Prisma's `…Array` tag is the scalar's plus 64, except
 * `UuidArray` (78; `Set`, 14, has no array form).
 */
export function arrayType(element: ColumnType): ColumnType {
  return element === T.Uuid ? T.UuidArray : (element + 64) as ColumnType;
}

function arrayCodec(element: Codec): Codec {
  return { type: arrayType(element.type), decode: decodeArray(element.decode) };
}

/**
 * The Prisma type and decoder of one result column. Arrays and domains resolve through their
 * base type; an enum's values are its labels. An unknown user type's kind is looked up once
 * (`kindOf`) — needed only for an array of enums, whose element kind the row description
 * does not carry.
 *
 * A `money` column (or an array or domain of one) is read at the fractional digits
 * `moneyScale` reports — the server's `lc_monetary` — and at two without it.
 *
 * @throws {DriverAdapterError} `UnsupportedNativeDataType` for a type Prisma has no reading
 *   of (`interval`, ranges, composites, geometric types): cast it in the query (`::text`).
 */
export async function columnCodec(
  column: SqlColumn,
  kindOf: TypeKindLookup,
  moneyScale?: MoneyScaleLookup,
): Promise<Codec> {
  const oid = column.typeOid ?? 0;
  const builtin = await builtinCodec(oid, moneyScale);
  if (builtin) return builtin;
  switch (column.typeKind) {
    case "enum":
      return ENUM_CODEC;
    case "array":
    case "domain": {
      if (column.baseTypeOid == null) throw unsupported(column.type);
      const base = await scalarCodec(column.baseTypeOid, column.baseType, kindOf, moneyScale);
      return column.typeKind === "array" ? arrayCodec(base) : base;
    }
    default:
      if (column.type === "citext") return CITEXT_CODEC;
      throw unsupported(column.type);
  }
}

/** A `Date` (or Prisma's ISO string) in the form a Postgres column of `dbType` takes. */
function dateArg(value: Date, dbType: string | undefined): string {
  switch (dbType) {
    case "TIME":
    case "TIMETZ":
      return formatUtcTime(value);
    case "DATE":
      return formatUtcDate(value);
    default:
      // The offset makes a `timestamptz` take the instant whatever the session's TimeZone;
      // a `timestamp` (without time zone) ignores it and keeps the UTC wall-clock time.
      return `${formatUtcDateTime(value)}+00:00`;
  }
}

/**
 * One Prisma argument in the form `Deno.SQL` binds for Postgres: datetimes as UTC text,
 * bytes as a `Uint8Array`, a list element by element; anything else as is.
 */
export function mapPostgresArg(arg: unknown, argType: ArgType): unknown {
  if (arg === null || arg === undefined) return null;
  if (Array.isArray(arg) && argType.arity === "list") {
    const element: ArgType = { ...argType, arity: "scalar" };
    return arg.map((value) => mapPostgresArg(value, element));
  }
  if (typeof arg === "string" && argType.scalarType === "datetime") {
    return dateArg(new Date(arg), argType.dbType);
  }
  if (arg instanceof Date) return dateArg(arg, argType.dbType);
  if (argType.scalarType === "bytes") {
    if (typeof arg === "string") return base64Bytes(arg);
    if (Array.isArray(arg)) return Uint8Array.from(arg as number[]);
  }
  if (ArrayBuffer.isView(arg) && !(arg instanceof Uint8Array)) {
    return new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
  }
  return arg;
}

/** The fields named in a `Key (a, b)=(…)` detail. */
function keyFields(detail: unknown): { fields: string[] } | undefined {
  const fields = typeof detail === "string" ? /Key \(([^)]+)\)/.exec(detail)?.[1] : undefined;
  return fields ? { fields: fields.split(", ") } : undefined;
}

/** The first double-quoted name in a server message (`relation "x" does not exist` → `x`). */
const quoted = (message: string) => /"([^"]+)"/.exec(message)?.[1];

/** A server error's fields, as `Deno.SQL` reports them. */
type ServerFields = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The failing column named by `column`, as a constraint. */
const columnConstraint = (e: ServerFields) => {
  const column = str(e.column);
  return column ? { fields: [column] } : undefined;
};

/** The table a default `<table>_<fields>_key` constraint name is on, as adapter-pg derives it. */
function keyConstraintTable(index: string | undefined, fields: string[]): string | undefined {
  const suffix = `_${fields.join("_")}_key`;
  return fields.length && index?.endsWith(suffix) ? index.slice(0, -suffix.length) : undefined;
}

/**
 * A unique violation as `@prisma/adapter-pg` reports it: the constraint by name (`index`) when the
 * server names it, else the `Key (…)` fields; the table from the server's `table` field, else
 * from a default `<table>_<fields>_key` constraint name.
 */
function uniqueViolation(e: ServerFields): MappedError {
  const index = str(e.constraint);
  const fields = keyFields(e.detail)?.fields ?? [];
  const table = str(e.table) ?? keyConstraintTable(index, fields);
  const constraint = index ? { index } : fields.length ? { fields } : undefined;
  return { kind: "UniqueConstraintViolation", constraint, ...(table && { table }) };
}

/** Prisma's error kind for each SQLSTATE it has one for. */
const SERVER_ERRORS: Record<string, (e: ServerFields, message: string) => MappedError> = {
  "22001": (e) => ({ kind: "LengthMismatch", column: str(e.column) }),
  "22003": (_e, message) => ({ kind: "ValueOutOfRange", cause: message }),
  "22P02": (_e, message) => ({ kind: "InvalidInputValue", message }),
  "23505": (e) => uniqueViolation(e),
  "23502": (e) => ({
    kind: "NullConstraintViolation",
    constraint: keyFields(e.detail) ?? columnConstraint(e),
  }),
  "23503": (e) => {
    const index = str(e.constraint);
    return {
      kind: "ForeignKeyConstraintViolation",
      constraint: columnConstraint(e) ?? (index ? { index } : undefined),
    };
  },
  "23001": (e) => {
    const index = str(e.constraint);
    return {
      kind: "RestrictViolation",
      constraint: columnConstraint(e) ?? (index ? { index } : undefined),
    };
  },
  "3D000": (_e, message) => ({ kind: "DatabaseDoesNotExist", db: quoted(message) }),
  "28000": (_e, message) => ({
    kind: "DatabaseAccessDenied",
    db: /database "([^"]+)"/.exec(message)?.[1],
  }),
  "28P01": (_e, message) => ({ kind: "AuthenticationFailed", user: quoted(message) }),
  "40001": () => ({ kind: "TransactionWriteConflict" }),
  "40P01": () => ({ kind: "TransactionWriteConflict" }),
  "42P01": (_e, message) => ({ kind: "TableDoesNotExist", table: quoted(message) }),
  "42703": (_e, message) => ({ kind: "ColumnNotFound", column: quoted(message) }),
  "42P04": (_e, message) => ({ kind: "DatabaseAlreadyExists", db: quoted(message) }),
  "53300": (_e, message) => ({ kind: "TooManyConnections", cause: message }),
};

/** A server error (SQLSTATE in `code`) as Prisma's error kind. */
function serverError(e: ServerFields, message: string): MappedError {
  const code = String(e.code);
  return SERVER_ERRORS[code]?.(e, message) ?? {
    kind: "postgres",
    code,
    severity: str(e.severity) ?? "N/A",
    message,
    detail: str(e.detail),
    column: str(e.column),
    hint: str(e.hint),
  };
}

/** A `Deno.SQL` client-side failure (an `ERR_POSTGRES_*` code) as Prisma's error kind. */
function clientError(code: string, message: string): MappedError | null {
  switch (code) {
    case "ERR_POSTGRES_CONNECTION_FAILED": {
      const at = /to ([^\s:]+):(\d+)/.exec(message);
      return { kind: "DatabaseNotReachable", host: at?.[1], port: at ? Number(at[2]) : undefined };
    }
    case "ERR_POSTGRES_CONNECTION_CLOSED":
      return { kind: "ConnectionClosed" };
    case "ERR_POSTGRES_CONNECTION_TIMEOUT":
      return { kind: "SocketTimeout" };
    case "ERR_POSTGRES_TLS_NOT_AVAILABLE":
    case "ERR_POSTGRES_TLS_UPGRADE_FAILED":
      return { kind: "TlsConnectionError", reason: message };
    default:
      return null;
  }
}

/**
 * A `Deno.SQL` Postgres error as Prisma's error, or null for an error that is not the
 * database's (Prisma then reports it as is).
 */
export function convertPostgresError(error: unknown): AdapterError | null {
  const fields = errorFields(error);
  if (!fields) return null;
  const { e, code, message } = fields;
  const mapped = code.startsWith("ERR_")
    ? clientError(code, message)
    : /^[0-9A-Z]{5}$/.test(code)
    ? serverError(e, message)
    : null;
  return mapped && { originalCode: code, originalMessage: message, ...mapped };
}
