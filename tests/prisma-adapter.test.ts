// `denext/prisma-adapter` without a database: the Postgres binary decoders, the column-type,
// argument and error mappings of both drivers, and the adapter / factory driven through a fake
// `Deno.SQL` client. The round trips against real databases are in
// tests/prisma-adapter-sqlite.test.ts and tests/prisma-adapter-postgres-integration.test.ts.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as bin from "../src/server/prisma-adapter/pg-binary.ts";
import * as pg from "../src/server/prisma-adapter/postgres.ts";
import * as lite from "../src/server/prisma-adapter/sqlite.ts";
import {
  DenoSqlAdapter,
  postgresDriver,
  resultColumns,
  sqliteDriver,
} from "../src/server/prisma-adapter/adapter.ts";
import type {
  DenoSqlClient,
  SqlColumn,
  SqlRequest,
  SqlRows,
} from "../src/server/prisma-adapter/client.ts";
import {
  type ArgType,
  ColumnTypeEnum as T,
  denoSqlHasColumns,
  DriverAdapterError,
  postgresConnection,
  PrismaDenoSql,
} from "../src/server/prisma-adapter/mod.ts";

/** A mapped error read field by field. */
type Loose = Record<string, unknown> | null;
/** A mapped error's fields (`{}` for none), read without optional chaining. */
const fields = (e: unknown) => (e ?? {}) as Record<string, unknown>;

// --- byte builders --------------------------------------------------------------------------

function bytes(build: (v: DataView) => void, size: number): Uint8Array {
  const b = new Uint8Array(size);
  build(new DataView(b.buffer));
  return b;
}
const i16 = (...xs: number[]) =>
  bytes((v) => xs.forEach((x, i) => v.setInt16(2 * i, x)), 2 * xs.length);
const i32 = (x: number) => bytes((v) => v.setInt32(0, x), 4);
const i64 = (x: bigint) => bytes((v) => v.setBigInt64(0, x), 8);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);
/** Postgres' binary array: ndim, flags, element OID, then (length, lower bound) per dimension. */
const array = (oid: number, dims: number[], elements: (Uint8Array | null)[]) =>
  cat(
    i32(dims.length),
    i32(elements.includes(null) ? 1 : 0),
    i32(oid),
    ...dims.flatMap((d) => [i32(d), i32(1)]),
    ...elements.map((e) => (e === null ? i32(-1) : cat(i32(e.length), e))),
  );
const numeric = (
  ndigits: number,
  weight: number,
  sign: number,
  dscale: number,
  ...digits: number[]
) =>
  cat(
    i16(ndigits, weight),
    bytes((v) => (v.setUint16(0, sign), v.setUint16(2, dscale)), 4),
    i16(...digits),
  );

Deno.test("pg-binary: integers, floats, booleans, text, json", () => {
  assertEquals(bin.decodeInt2(i16(-7)), -7);
  assertEquals(bin.decodeInt4(i32(123456)), 123456);
  assertEquals(bin.decodeInt8(i64(9007199254740993n)), "9007199254740993");
  assertEquals(bin.decodeOid(i32(-1)), 4294967295);
  assertEquals(bin.decodeFloat8(bytes((v) => v.setFloat64(0, 2.5), 8)), 2.5);
  assertEquals(bin.decodeFloat4(bytes((v) => v.setFloat32(0, 0.1), 4)), 0.1);
  assertEquals(bin.decodeFloat4(bytes((v) => v.setFloat32(0, Infinity), 4)), Infinity);
  assertEquals(bin.shortestFloat32(Math.fround(1 / 3)), 0.33333334);
  assertEquals(bin.decodeBool(new Uint8Array([1])), true);
  assertEquals(bin.decodeBool(new Uint8Array([0])), false);
  assertEquals(bin.decodeText(text("héllo")), "héllo");
  assertEquals(bin.decodeJsonb(cat(new Uint8Array([1]), text('{"a": 1}'))), '{"a": 1}');
  assertEquals(bin.decodeBytea(new Uint8Array([0, 255])), [0, 255]);
});

Deno.test("pg-binary: numeric at every scale and sign", () => {
  assertEquals(bin.decodeNumeric(numeric(2, 0, 0, 3, 12, 3400)), "12.340");
  assertEquals(bin.decodeNumeric(numeric(2, 1, 0x4000, 0, 1, 2345)), "-12345");
  assertEquals(bin.decodeNumeric(numeric(1, 2, 0, 0, 7)), "700000000");
  assertEquals(bin.decodeNumeric(numeric(1, -2, 0, 5, 1000)), "0.00001");
  assertEquals(bin.decodeNumeric(numeric(0, 0, 0, 2)), "0.00");
  assertEquals(bin.decodeNumeric(numeric(0, 0, 0xc000, 0)), "NaN");
  assertEquals(bin.decodeNumeric(numeric(0, 0, 0xd000, 0)), "Infinity");
  assertEquals(bin.decodeNumeric(numeric(0, 0, 0xf000, 0)), "-Infinity");
  assertEquals(bin.decodeMoney(i64(-150n)), "-1.50");
  assertEquals(bin.decodeMoney(i64(123405n)), "1234.05");
  assertEquals(bin.moneyDecoder(0)(i64(-1500n)), "-1500");
  assertEquals(bin.moneyDecoder(3)(i64(1234005n)), "1234.005");
  assertEquals(bin.moneyDecoder(3)(i64(-5n)), "-0.005");
});

Deno.test("pg-binary: dates, times and timestamps in UTC", () => {
  assertEquals(bin.decodeDate(i32(8780)), "2024-01-15");
  assertEquals(bin.decodeDate(i32(-1)), "1999-12-31");
  assertEquals(bin.decodeDate(i32(0x7fffffff)), "infinity");
  assertEquals(bin.decodeDate(i32(-0x80000000)), "-infinity");
  assertEquals(bin.decodeTime(i64(45296789000n)), "12:34:56.789");
  assertEquals(bin.decodeTime(i64(3600000000n)), "01:00:00");
  assertEquals(bin.decodeTimetz(cat(i64(29350000000n), i32(-7200))), "08:09:10");
  const day = 86_400_000_000n;
  assertEquals(
    bin.decodeTimestamp(i64(8780n * day + 45296123456n)),
    "2024-01-15T12:34:56.123456+00:00",
  );
  assertEquals(bin.decodeTimestamp(i64(-1n)), "1999-12-31T23:59:59.999999+00:00");
  assertEquals(bin.decodeTimestamp(i64(0x7fffffffffffffffn)), "infinity");
  assertEquals(bin.decodeTimestamp(i64(-0x8000000000000000n)), "-infinity");
});

Deno.test("pg-binary: uuid, bit strings, network addresses", () => {
  const uuid = Uint8Array.from(
    "a0eebc999c0b4ef8bb6d6bb9bd380a11".match(/../g)!,
    (h) => parseInt(h, 16),
  );
  assertEquals(bin.decodeUuid(uuid), "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
  assertEquals(
    bin.decodeBits(cat(i32(10), new Uint8Array([0b11001100, 0b11000000]))),
    "1100110011",
  );
  const inet = (family: number, bits: number, cidr: number, addr: number[]) =>
    new Uint8Array([family, bits, cidr, addr.length, ...addr]);
  assertEquals(bin.decodeInet(inet(2, 32, 0, [10, 1, 2, 3])), "10.1.2.3");
  assertEquals(bin.decodeInet(inet(2, 8, 1, [10, 0, 0, 0])), "10.0.0.0/8");
  const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  assertEquals(bin.decodeInet(inet(3, 64, 0, v6)), "2001:db8::1/64");
  assertEquals(bin.decodeInet(inet(3, 128, 0, [...Array(15).fill(0), 1])), "::1");
  assertEquals(
    bin.decodeInet(inet(3, 128, 0, [...Array(10).fill(0), 255, 255, 1, 2, 3, 4])),
    "::ffff:1.2.3.4",
  );
  assertEquals(
    bin.decodeInet(inet(3, 128, 0, [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8])),
    "1:2:3:4:5:6:7:8",
  );
  assertEquals(
    bin.decodeInet(inet(3, 128, 0, [0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3])),
    "1:0:0:2::3",
  );
});

Deno.test("pg-binary: arrays — flat, nested, with nulls, empty", () => {
  const ints = bin.decodeArray(bin.decodeInt4);
  assertEquals(ints(array(23, [3], [i32(1), null, i32(3)])), [1, null, 3]);
  assertEquals(ints(array(23, [2, 2], [i32(1), i32(2), i32(3), i32(4)])), [[1, 2], [3, 4]]);
  assertEquals(ints(cat(i32(0), i32(0), i32(23))), []);
  assertEquals(bin.decodeArray(bin.decodeText)(array(25, [2], [text("a"), text("b,c")])), [
    "a",
    "b,c",
  ]);
});

// --- Postgres mappings ----------------------------------------------------------------------

const col = (c: Partial<SqlColumn>): SqlColumn => ({ name: "v", type: null, ...c });
const noKinds = () => Promise.resolve(null);

Deno.test("postgres: each column's Prisma type", async () => {
  const codec = (c: Partial<SqlColumn>, kindOf: pg.TypeKindLookup = noKinds) =>
    pg.columnCodec(col(c), kindOf);
  assertEquals((await codec({ typeOid: 1114 })).type, T.DateTime);
  assertEquals(
    (await codec({ typeOid: 1007, typeKind: "array", baseTypeOid: 23 })).type,
    T.Int32Array,
  );
  assertEquals(
    (await codec({ typeOid: 2951, typeKind: "array", baseTypeOid: 2950 })).type,
    T.UuidArray,
  );
  assertEquals((await codec({ typeOid: 16386, typeKind: "enum", type: "mood" })).type, T.Enum);
  assertEquals(
    (await codec({ typeOid: 16390, typeKind: "domain", baseTypeOid: 23 })).type,
    T.Int32,
  );
  assertEquals((await codec({ typeOid: 16400, typeKind: "simple", type: "citext" })).type, T.Text);
  const asked: number[] = [];
  const enumArray = await codec(
    { typeOid: 16385, typeKind: "array", baseTypeOid: 16386, baseType: "mood" },
    (oid) => (asked.push(oid), Promise.resolve("e")),
  );
  assertEquals([enumArray.type, asked], [T.EnumArray, [16386]]);
  assertEquals(enumArray.decode(array(16386, [1], [text("happy")])), ["happy"]);
  assertEquals(
    (await codec({ typeOid: 16500, typeKind: "array", baseTypeOid: 16400, baseType: "citext" }))
      .type,
    T.TextArray,
  );

  const unsupported = async (c: Partial<SqlColumn>, kind: pg.TypeKindLookup = noKinds) => {
    const err = await assertRejects(() => codec(c, kind), DriverAdapterError);
    return err.cause as Loose;
  };
  assertEquals(await unsupported({ typeOid: 1186, typeKind: "simple", type: "interval" }), {
    kind: "UnsupportedNativeDataType",
    type: "interval",
  });
  assertEquals(await unsupported({ typeOid: 16600, typeKind: "composite", type: "pair" }), {
    kind: "UnsupportedNativeDataType",
    type: "pair",
  });
  assertEquals(
    (await unsupported(
      { typeOid: 16601, typeKind: "array", baseTypeOid: 16600, baseType: "pair" },
      () => Promise.resolve("c"),
    ))?.type,
    "pair",
  );
  assertEquals((await unsupported({ typeOid: 16602, typeKind: "domain" }))?.type, "Unknown");
  assertEquals(pg.arrayType(T.Json), T.JsonArray);
});

const scalar = (scalarType: ArgType["scalarType"], dbType?: string): ArgType => ({
  scalarType,
  arity: "scalar",
  dbType,
});

Deno.test("postgres: Prisma's arguments in the form Postgres binds", () => {
  assertEquals(pg.mapPostgresArg(null, scalar("int")), null);
  assertEquals(pg.mapPostgresArg(undefined, scalar("int")), null);
  assertEquals(
    pg.mapPostgresArg("2024-03-10T02:30:00.123Z", scalar("datetime")),
    "2024-03-10 02:30:00.123+00:00",
  );
  assertEquals(
    pg.mapPostgresArg(new Date("2024-03-10T02:30:00Z"), scalar("datetime")),
    "2024-03-10 02:30:00+00:00",
  );
  assertEquals(pg.mapPostgresArg("2024-02-29T00:00:00Z", scalar("datetime", "DATE")), "2024-02-29");
  assertEquals(
    pg.mapPostgresArg("1970-01-01T13:14:15.678Z", scalar("datetime", "TIME")),
    "13:14:15.678",
  );
  assertEquals(pg.mapPostgresArg("1970-01-01T13:14:15Z", scalar("datetime", "TIMETZ")), "13:14:15");
  assertEquals(pg.mapPostgresArg("AQL/", scalar("bytes")), new Uint8Array([1, 2, 255]));
  assertEquals(pg.mapPostgresArg([1, 2], scalar("bytes")), new Uint8Array([1, 2]));
  assertEquals(
    pg.mapPostgresArg(new DataView(new Uint8Array([9]).buffer), scalar("unknown")),
    new Uint8Array([9]),
  );
  const u8 = new Uint8Array([4]);
  assertEquals(pg.mapPostgresArg(u8, scalar("bytes")), u8);
  assertEquals(
    pg.mapPostgresArg(["2024-01-15T00:00:00Z", null], {
      scalarType: "datetime",
      dbType: "DATE",
      arity: "list",
    }),
    ["2024-01-15", null],
  );
  assertEquals(pg.mapPostgresArg("x", scalar("string")), "x");
  assertEquals(pg.mapPostgresArg(5, scalar("int")), 5);
});

Deno.test("postgres: errors as Prisma's kinds", () => {
  const conv = (e: Record<string, unknown>) =>
    fields(pg.convertPostgresError({ message: "m", severity: "ERROR", ...e }));
  assertEquals(conv({ code: "22001", column: "c" }).kind, "LengthMismatch");
  assertEquals(conv({ code: "22003" }), {
    kind: "ValueOutOfRange",
    cause: "m",
    originalCode: "22003",
    originalMessage: "m",
  });
  assertEquals(
    conv({ code: "23505", detail: "Key (a, b)=(1, 2) already exists." }).constraint,
    { fields: ["a", "b"] },
  );
  assertEquals(conv({ code: "23505", detail: "no key" }).constraint, undefined);
  assertEquals(conv({ code: "23502", column: "email" }).constraint, { fields: ["email"] });
  assertEquals(conv({ code: "23502" }).constraint, undefined);
  assertEquals(conv({ code: "23503", column: "pid" }).constraint, { fields: ["pid"] });
  assertEquals(conv({ code: "23503", constraint: "c_fk" }).constraint, { index: "c_fk" });
  assertEquals(conv({ code: "23503" }).constraint, undefined);
  const db = (code: string, message: string) => fields(pg.convertPostgresError({ code, message }));
  assertEquals(db("3D000", 'database "nodb" does not exist').db, "nodb");
  assertEquals(
    db("28000", 'no pg_hba.conf entry for host "1.2.3.4", user "u", database "app"').db,
    "app",
  );
  assertEquals(db("28P01", 'password authentication failed for user "postgres"').user, "postgres");
  assertEquals(db("40001", "x").kind, "TransactionWriteConflict");
  assertEquals(db("42P01", 'relation "nope" does not exist').table, "nope");
  assertEquals(db("42703", 'column "nope" does not exist').column, "nope");
  assertEquals(db("42P04", 'database "app" already exists').db, "app");
  assertEquals(db("53300", "too many").kind, "TooManyConnections");
  assertEquals(db("22012", "division by zero"), {
    kind: "postgres",
    code: "22012",
    severity: "N/A",
    message: "division by zero",
    detail: undefined,
    column: undefined,
    hint: undefined,
    originalCode: "22012",
    originalMessage: "division by zero",
  });
  const refused = db(
    "ERR_POSTGRES_CONNECTION_FAILED",
    "Failed to connect to db.local:5433: refused",
  );
  assertEquals([refused.kind, refused.host, refused.port], [
    "DatabaseNotReachable",
    "db.local",
    5433,
  ]);
  assertEquals(db("ERR_POSTGRES_CONNECTION_FAILED", "no address").port, undefined);
  assertEquals(db("ERR_POSTGRES_CONNECTION_CLOSED", "x").kind, "ConnectionClosed");
  assertEquals(db("ERR_POSTGRES_CONNECTION_TIMEOUT", "x").kind, "SocketTimeout");
  assertEquals(db("ERR_POSTGRES_TLS_UPGRADE_FAILED", "bad cert").kind, "TlsConnectionError");
  assertEquals(db("ERR_POSTGRES_TLS_NOT_AVAILABLE", "no tls").kind, "TlsConnectionError");
  assertEquals(
    pg.convertPostgresError({ code: "ERR_POSTGRES_PROTOCOL_ERROR", message: "x" }),
    null,
  );
  assertEquals(pg.convertPostgresError({ code: "not-a-sqlstate", message: "x" }), null);
  assertEquals(pg.convertPostgresError(new Error("plain")), null);
  assertEquals(pg.convertPostgresError("string"), null);
  assertEquals(fields(pg.convertPostgresError({ code: "22012" })).originalMessage, "22012");
});

// --- SQLite mappings ------------------------------------------------------------------------

Deno.test("sqlite: declared and inferred column types", () => {
  assertEquals(lite.declaredType("varchar(20)"), T.Text);
  assertEquals(lite.declaredType("decimal(10, 2)"), T.Numeric);
  assertEquals(lite.declaredType("JSONB"), T.Json);
  assertEquals(lite.declaredType("geometry"), null);
  assertEquals(lite.declaredType(null), null);
  assertEquals(lite.declaredType(""), null);
  const columns = ["a", "b", "c", "d", "e", "f", "g"].map((name) => col({ name }));
  assertEquals(
    lite.columnTypes(columns, [[null, null, null, null, null, null, null], [
      "s",
      1n,
      true,
      1.5,
      new Uint8Array(),
      null,
      2,
    ]]),
    [T.Text, T.Int64, T.Boolean, T.UnknownNumber, T.Bytes, T.Int32, T.UnknownNumber],
  );
  assertThrows(() => lite.columnTypes([col({})], [[{}]]), TypeError);
});

Deno.test("sqlite: rows as Prisma reads them", () => {
  assertEquals(
    lite.mapRow(
      [
        new Uint8Array([1]),
        2.7,
        3n,
        9007199254740993n,
        1705320000000,
        1705320000000n,
        "s",
        undefined,
        -5n,
      ],
      [T.Bytes, T.Int32, T.Int32, T.Int32, T.DateTime, T.DateTime, T.Text, T.Text, T.Int64],
    ),
    [
      [1],
      2,
      3,
      "9007199254740993",
      "2024-01-15T12:00:00.000Z",
      "2024-01-15T12:00:00.000Z",
      "s",
      null,
      "-5",
    ],
  );
});

Deno.test("sqlite: Prisma's arguments in the form SQLite binds", () => {
  const map = (arg: unknown, t: ArgType["scalarType"], format: lite.TimestampFormat = "iso8601") =>
    lite.mapSqliteArg(arg, scalar(t), format);
  assertEquals(map(null, "int"), null);
  assertEquals(map(undefined, "int"), null);
  assertEquals(map(true, "boolean"), 1);
  assertEquals(map(false, "boolean"), 0);
  assertEquals(map("42", "int"), 42);
  assertEquals(map("1.5", "float"), 1.5);
  assertEquals(map("2.25", "decimal"), 2.25);
  assertEquals(map("9007199254740993", "bigint"), 9007199254740993n);
  assertEquals(map("text", "string"), "text");
  assertEquals(map("2024-01-15T12:00:00.000Z", "datetime"), "2024-01-15T12:00:00.000+00:00");
  assertEquals(map(new Date(0), "datetime", "unixepoch-ms"), 0);
  assertEquals(map("AQI=", "bytes"), new Uint8Array([1, 2]));
  assertEquals(map([3, 4], "bytes"), new Uint8Array([3, 4]));
  assertEquals(map(7, "int"), 7);
});

Deno.test("sqlite: errors as Prisma's kinds", () => {
  const conv = (code: string, message: string, errno?: number) =>
    fields(lite.convertSqliteError({ code, message, errno }));
  assertEquals(conv("SQLITE_BUSY", "busy").kind, "SocketTimeout");
  assertEquals(conv("ERR_SQLITE_CONNECTION_TIMEOUT", "t").kind, "SocketTimeout");
  assertEquals(
    conv("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: User.id, User.org").constraint,
    { fields: ["id", "org"] },
  );
  assertEquals(conv("SQLITE_CONSTRAINT_UNIQUE", "odd message").constraint, undefined);
  assertEquals(conv("SQLITE_CONSTRAINT_TRIGGER", "x").kind, "ForeignKeyConstraintViolation");
  assertEquals(conv("SQLITE_ERROR", "table t has no column named z", 1).column, "z");
  assertEquals(conv("SQLITE_READONLY", "attempt to write a readonly database", 8), {
    kind: "sqlite",
    extendedCode: 8,
    message: "attempt to write a readonly database",
    originalCode: "SQLITE_READONLY",
    originalMessage: "attempt to write a readonly database",
  });
  assertEquals(lite.convertSqliteError({ code: "SQLITE_ERROR", message: "no errno" }), null);
  assertEquals(lite.convertSqliteError(new Error("plain")), null);
});

// --- the adapter over a fake client ---------------------------------------------------------

/** A result array with `Deno.SQL`'s extra fields. */
function rows<T>(list: T[], extra: Partial<SqlRows<T>> = {}): SqlRows<T> {
  return Object.assign([...list], { count: list.length }, extra);
}

/** A thenable query that resolves (or rejects with) `result`, whatever form is asked. */
function request(result: SqlRows<unknown> | Error, log: string[], text: string): SqlRequest {
  const settle = () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
  const req: SqlRequest = {
    then: (ok, fail) => settle().then(ok as never, fail),
    values: () => (log.push(`values ${text}`), req) as unknown as SqlRequest<unknown[]>,
    raw: () => (log.push(`raw ${text}`), req) as unknown as SqlRequest<(Uint8Array | null)[]>,
    simple: () => (log.push(`simple ${text}`), req),
  };
  return req;
}

/** A fake `Deno.SQL` answering each SQL text from `answers` (default: no rows, no columns). */
function fakeClient(answers: Record<string, SqlRows<unknown> | Error> = {}, log: string[] = []) {
  let reserved = 0, released = 0, closed = 0;
  const client: DenoSqlClient = {
    unsafe(textIn, params) {
      log.push(`unsafe ${textIn}${params?.length ? ` ${JSON.stringify(params)}` : ""}`);
      return request(answers[textIn] ?? rows([], { columns: [] }), log, textIn);
    },
    reserve:
      () => (reserved++,
        answers.__reserve instanceof Error
          ? Promise.reject(answers.__reserve)
          : Promise.resolve(client)),
    release: () => void released++,
    close: () => (closed++, Promise.resolve()),
  };
  return { client, log, counts: () => ({ reserved, released, closed }) };
}

const query = (sql: string, args: unknown[] = [], argTypes: ArgType[] = []) => ({
  sql,
  args,
  argTypes,
});

Deno.test("adapter: Postgres results decoded from binary, user-type kinds looked up once", async () => {
  const columns = [
    col({ name: "id", typeOid: 20 }),
    col({ name: "moods", typeOid: 16385, typeKind: "array", baseTypeOid: 16386, baseType: "mood" }),
  ];
  const lookup = "select typtype::text from pg_type where oid = $1";
  const { client, log } = fakeClient({
    "select x": rows([[i64(5n), array(16386, [1], [text("sad")])], [null, null]], { columns }),
    [lookup]: rows([["e"]], { columns: [col({ name: "typtype" })] }),
  });
  const db = new DenoSqlAdapter(client, postgresDriver("app"), () => Promise.resolve());
  const r = await db.queryRaw(
    query("select x", ["2024-01-15T00:00:00Z"], [scalar("datetime", "DATE")]),
  );
  assertEquals(r, {
    columnNames: ["id", "moods"],
    columnTypes: [T.Int64, T.EnumArray],
    rows: [["5", ["sad"]], [null, null]],
  });
  await db.queryRaw(query("select x"));
  assertEquals(log.filter((l) => l.startsWith(`unsafe ${lookup}`)).length, 1);
  assert(log.includes('unsafe select x ["2024-01-15"]'));
  assert(log.includes("raw select x"));
  assertEquals(db.getConnectionInfo(), { schemaName: "app", supportsRelationJoins: true });
  assertEquals([db.provider, db.adapterName], ["postgres", "denext/prisma-adapter"]);
});

Deno.test("adapter: money is read at lc_monetary's fractional digits, asked once", async () => {
  const columns = [
    col({ name: "price", typeOid: 790 }),
    col({ name: "prices", typeOid: 791, typeKind: "array", baseTypeOid: 790, baseType: "money" }),
  ];
  const lookup = "select scale('1'::money::numeric)::int4";
  const { client, log } = fakeClient({
    "select x": rows([[i64(1500n), array(790, [2], [i64(7n), i64(-3n)])]], { columns }),
    [lookup]: rows([[0]], { columns: [col({ name: "scale" })] }),
  });
  const db = new DenoSqlAdapter(client, postgresDriver(undefined), () => Promise.resolve());
  const r = await db.queryRaw(query("select x"));
  assertEquals(r.columnTypes, [T.Numeric, T.NumericArray]);
  assertEquals(r.rows, [["1500", ["7", "-3"]]]);
  await db.queryRaw(query("select x"));
  assertEquals(log.filter((l) => l === `unsafe ${lookup}`).length, 1);
  // A result without a money column asks nothing.
  const plain = fakeClient({ "select y": rows([[i64(1n)]], { columns: [col({ typeOid: 20 })] }) });
  const db2 = new DenoSqlAdapter(plain.client, postgresDriver(undefined), () => Promise.resolve());
  await db2.queryRaw(query("select y"));
  assert(!plain.log.includes(`unsafe ${lookup}`));
});

Deno.test("adapter: a failed money scale lookup is asked again; a bad scale reads two digits", async () => {
  const columns = [col({ name: "price", typeOid: 790 })];
  const lookup = "select scale('1'::money::numeric)::int4";
  const answers: Record<string, SqlRows<unknown> | Error> = {
    "select x": rows([[i64(1500n)]], { columns }),
    [lookup]: new Error("lookup down"),
  };
  const { client, log } = fakeClient(answers);
  const db = new DenoSqlAdapter(client, postgresDriver(undefined), () => Promise.resolve());
  await assertRejects(() => db.queryRaw(query("select x")));
  // Not cached: the next result asks again, and an out-of-range answer falls back to 2 digits.
  answers[lookup] = rows([[99]], { columns: [col({ name: "scale" })] });
  const r = await db.queryRaw(query("select x"));
  assertEquals(r.rows, [["15.00"]]);
  assertEquals(log.filter((l) => l === `unsafe ${lookup}`).length, 2);
});

Deno.test("postgres: a money column without a scale lookup reads two digits", async () => {
  const codec = await pg.columnCodec(col({ typeOid: 790 }), noKinds);
  assertEquals(codec.decode(i64(-150n)), "-1.50");
  const scaled = await pg.columnCodec(
    col({ typeOid: 16700, typeKind: "domain", baseTypeOid: 790 }),
    noKinds,
    () => Promise.resolve(3),
  );
  assertEquals([scaled.type, scaled.decode(i64(1005n))], [T.Numeric, "1.005"]);
});

Deno.test("adapter: an unknown user type's kind may be missing", async () => {
  const columns = [col({ typeOid: 16385, typeKind: "array", baseTypeOid: 16386, baseType: "x" })];
  const { client } = fakeClient({ "select x": rows([], { columns }) });
  const db = new DenoSqlAdapter(client, postgresDriver(undefined), () => Promise.resolve());
  const err = await assertRejects(() => db.queryRaw(query("select x")), DriverAdapterError);
  assertEquals(err.cause, { kind: "UnsupportedNativeDataType", type: "x" });
});

Deno.test("adapter: a runtime without result columns says which runtime it needs", async () => {
  assertThrows(() => resultColumns(rows([])), Error, "3.0.0-rc.1");
  const { client } = fakeClient({ "select 1": rows([[1]]) });
  const db = new DenoSqlAdapter(client, sqliteDriver("iso8601"), () => Promise.resolve());
  await assertRejects(() => db.queryRaw(query("select 1")), Error, "result.columns");
});

Deno.test("adapter: SQLite results, rowid, counts, scripts, errors", async () => {
  const sqliteErr = Object.assign(new Error("UNIQUE constraint failed: t.a"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
    errno: 2067,
  });
  const { client, log } = fakeClient({
    "insert returning": rows([[1n]], {
      columns: [col({ name: "id", type: "INTEGER" })],
      command: "INSERT",
      lastInsertRowid: 1n,
    }),
    "update t": rows([], { count: 3, columns: [] }),
    "bad": sqliteErr,
    "boom": new Error("not a database error"),
  });
  const db = new DenoSqlAdapter(client, sqliteDriver("iso8601"), () => Promise.resolve());
  const ins = await db.queryRaw(query("insert returning", [true], [scalar("boolean")]));
  assertEquals(ins, {
    columnNames: ["id"],
    columnTypes: [T.Int32],
    rows: [[1]],
    lastInsertId: "1",
  });
  assert(log.includes("unsafe insert returning [1]"));
  assertEquals(await db.executeRaw(query("update t")), 3);
  const err = await assertRejects(() => db.executeRaw(query("bad")), DriverAdapterError);
  assertEquals(err.cause.kind, "UniqueConstraintViolation");
  await assertRejects(() => db.queryRaw(query("boom")), Error, "not a database error");
  await db.executeScript("a; b");
  assert(log.includes("simple a; b"));
  await assertRejects(() => db.executeScript("bad"), DriverAdapterError);
  assertEquals(db.getConnectionInfo(), { supportsRelationJoins: false });
});

Deno.test("adapter: transactions reserve, BEGIN, set the level, and release once", async () => {
  const { client, log, counts } = fakeClient();
  const db = new DenoSqlAdapter(client, postgresDriver(undefined), () => Promise.resolve());
  const tx = await db.startTransaction("REPEATABLE READ");
  assertEquals(log.slice(-2), [
    "unsafe BEGIN",
    "unsafe SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  ]);
  assertEquals(await tx.executeRaw(query("COMMIT")), 0);
  await tx.commit();
  await tx.rollback();
  assertEquals(counts(), { reserved: 1, released: 1, closed: 0 });

  const sqlite = new DenoSqlAdapter(client, sqliteDriver("iso8601"), () => Promise.resolve());
  const tx2 = await sqlite.startTransaction("SERIALIZABLE");
  assertEquals(log.at(-1), "unsafe BEGIN");
  await tx2.rollback();
  await assertRejects(() => sqlite.startTransaction("READ COMMITTED"), DriverAdapterError);
});

Deno.test("adapter: a failed COMMIT rolls back and releases; other failures keep the connection", async () => {
  const fail = Object.assign(new Error("could not serialize"), {
    code: "40001",
    severity: "ERROR",
  });
  const { client, log, counts } = fakeClient({ " commit": fail, "insert x": fail });
  const db = new DenoSqlAdapter(client, postgresDriver(undefined), () => Promise.resolve());
  const tx = await db.startTransaction();
  const err = await assertRejects(() => tx.executeRaw(query("insert x")), DriverAdapterError);
  assertEquals(err.cause.kind, "TransactionWriteConflict");
  assertEquals(counts().released, 0);
  await assertRejects(() => tx.executeRaw(query(" commit")), DriverAdapterError);
  assertEquals(log.at(-1), "unsafe ROLLBACK");
  assertEquals(counts().released, 1);
  await tx.commit();
  assertEquals(counts().released, 1);
});

Deno.test("adapter: a failed reserve or BEGIN is mapped and holds nothing", async () => {
  const closed = Object.assign(new Error("closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
  const a = fakeClient({ __reserve: closed });
  const db = new DenoSqlAdapter(a.client, postgresDriver(undefined), () => Promise.resolve());
  assertEquals(
    (await assertRejects(() => db.startTransaction(), DriverAdapterError)).cause.kind,
    "ConnectionClosed",
  );

  const b = fakeClient({ BEGIN: closed });
  const db2 = new DenoSqlAdapter(b.client, postgresDriver(undefined), () => Promise.resolve());
  await assertRejects(() => db2.startTransaction(), DriverAdapterError);
  assertEquals(b.counts(), { reserved: 1, released: 1, closed: 0 });
  assertEquals(b.log.at(-1), "unsafe ROLLBACK");
});

// --- the factory ----------------------------------------------------------------------------

/** Run `fn` with `Deno.SQL` replaced by `value` (or removed for `undefined`). */
async function withDenoSql(value: unknown, fn: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(Deno, "SQL");
  Object.defineProperty(Deno, "SQL", { value, configurable: true, writable: true });
  if (value === undefined) delete (Deno as { SQL?: unknown }).SQL;
  try {
    await fn();
  } finally {
    if (saved) Object.defineProperty(Deno, "SQL", saved);
    else delete (Deno as { SQL?: unknown }).SQL;
  }
}

/** A fake `Deno.SQL` constructor recording what it was opened with. */
function recordingSql() {
  const opened: {
    url: string;
    options: Record<string, unknown>;
    client: ReturnType<typeof fakeClient>;
  }[] = [];
  class FakeSql {
    constructor(url: string, options: Record<string, unknown>) {
      const fake = fakeClient();
      opened.push({ url, options, client: fake });
      return fake.client;
    }
  }
  return { FakeSql, opened };
}

Deno.test("factory: the database comes from the URL, the client, or the option", () => {
  assertEquals(new PrismaDenoSql("postgres://h/db").provider, "postgres");
  assertEquals(new PrismaDenoSql("postgresql://h/db").provider, "postgres");
  assertEquals(new PrismaDenoSql(new URL("file:///tmp/x.db")).provider, "sqlite");
  assertEquals(new PrismaDenoSql(":memory:").provider, "sqlite");
  assertEquals(new PrismaDenoSql("sqlite://x.db").provider, "sqlite");
  assertEquals(new PrismaDenoSql("custom", { provider: "sqlite" }).provider, "sqlite");
  assertThrows(() => new PrismaDenoSql("mysql://h/db"), TypeError, "pass { provider }");
  const { client } = fakeClient();
  assertEquals(new PrismaDenoSql(client).provider, "postgres");
  assertEquals(new PrismaDenoSql({ ...client, options: { adapter: "sqlite" } }).provider, "sqlite");
});

Deno.test("factory: Prisma's URL parameters become Deno.SQL options", () => {
  const c = postgresConnection(
    "postgres://u:p%40ss@h:5433/db?schema=my%22s&connection_limit=5&connect_timeout=7&pool_timeout=9&pgbouncer=true&sslmode=require&socket_timeout=3",
    undefined,
  );
  assertEquals(c.url, "postgres://u:p%40ss@h:5433/db?sslmode=require");
  assertEquals(c.schema, 'my"s');
  assertEquals(c.options, {
    adapter: "postgres",
    connection: { search_path: '"my""s"' },
    max: 5,
    connectionTimeout: 7,
    prepare: false,
  });
  const plain = postgresConnection("postgres://h/db?pool_timeout=4", "app");
  assertEquals(plain, {
    url: "postgres://h/db",
    schema: "app",
    options: { adapter: "postgres", connection: { search_path: '"app"' }, connectionTimeout: 4 },
  });
  assertEquals(postgresConnection("postgres://h/db", undefined).options, { adapter: "postgres" });
});

Deno.test("factory: connect opens a client of its own and closes it on dispose", async () => {
  const { FakeSql, opened } = recordingSql();
  await withDenoSql(FakeSql, async () => {
    const pgDb = await new PrismaDenoSql("postgres://h/db?schema=s", { sql: { max: 3 } }).connect();
    assertEquals(opened[0].url, "postgres://h/db");
    assertEquals(opened[0].options, {
      adapter: "postgres",
      connection: { search_path: '"s"' },
      max: 3,
    });
    assertEquals(pgDb.getConnectionInfo?.(), { schemaName: "s", supportsRelationJoins: true });
    await pgDb.dispose();
    assertEquals(opened[0].client.counts().closed, 1);

    const liteDb = await new PrismaDenoSql("file:./dev.db").connect();
    assertEquals(opened[1].options, { bigint: true, adapter: "sqlite" });
    await liteDb.dispose();

    const shadow = await new PrismaDenoSql("file:./dev.db").connectToShadowDb();
    assertEquals(opened[2].url, ":memory:");
    await shadow.dispose();
    await (await new PrismaDenoSql("file:./dev.db", { shadowDatabaseUrl: "file:./s.db" })
      .connectToShadowDb())
      .dispose();
    assertEquals(opened[3].url, "file:./s.db");
    await (await new PrismaDenoSql("postgres://h/db", { shadowDatabaseUrl: "postgres://h/shadow" })
      .connectToShadowDb()).dispose();
    assertEquals(opened[4].url, "postgres://h/shadow");
  });
});

Deno.test("factory: a Postgres shadow database is created beside the URL's and dropped", async () => {
  const { FakeSql, opened } = recordingSql();
  await withDenoSql(FakeSql, async () => {
    const shadow = await new PrismaDenoSql("postgres://h:1/app?sslmode=disable")
      .connectToShadowDb();
    const [main, side] = opened;
    const name = /CREATE DATABASE "([^"]+)"/.exec(main.client.log.join("\n"))?.[1];
    assert(name?.startsWith("prisma_migrate_shadow_db_"));
    assertEquals(side.url, `postgres://h:1/${name}?sslmode=disable`);
    await shadow.dispose();
    assert(main.client.log.includes(`simple DROP DATABASE IF EXISTS "${name}"`));
    assertEquals([main.client.counts().closed, side.client.counts().closed], [1, 1]);
  });
});

Deno.test("factory: a passed client is used, and closed only when asked", async () => {
  const a = fakeClient();
  await (await new PrismaDenoSql(a.client).connect()).dispose();
  assertEquals(a.counts().closed, 0);
  await (await new PrismaDenoSql(a.client, { disposeClient: true }).connect()).dispose();
  assertEquals(a.counts().closed, 1);
  await assertRejects(
    () => new PrismaDenoSql(a.client).connectToShadowDb(),
    Error,
    "shadowDatabaseUrl",
  );
});

Deno.test("factory: no Deno.SQL is a clear error, and no column support", async () => {
  await withDenoSql(undefined, async () => {
    await assertRejects(() => new PrismaDenoSql("postgres://h/db").connect(), Error, "no Deno.SQL");
    assertEquals(await denoSqlHasColumns(), false);
  });
  const { FakeSql } = recordingSql();
  await withDenoSql(FakeSql, async () => assertEquals(await denoSqlHasColumns(), false));
  class Throwing {
    constructor() {
      throw new Error("cannot open");
    }
  }
  await withDenoSql(Throwing, async () => assertEquals(await denoSqlHasColumns(), false));
  class WithColumns {
    constructor() {
      return fakeClient({ "select 1 as probe": rows([[1]], { columns: [col({ name: "probe" })] }) })
        .client;
    }
  }
  await withDenoSql(WithColumns, async () => assertEquals(await denoSqlHasColumns(), true));
});
