// `denext/prisma-adapter` on a real Postgres: every column type Prisma reads makes the round
// trip (written with Prisma's argument forms, read back with the column type and value Prisma
// expects), errors map to Prisma's kinds, transactions commit, roll back and release their
// connection, scripts run whole, and a shadow database is created and dropped.
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
//     denext test -A tests/prisma-adapter-postgres-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL, or on a runtime whose Deno.SQL reports no result
// columns (before denext's Deno runtime 3.0.0-rc.1).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ArgType,
  ColumnTypeEnum as T,
  denoSqlHasColumns,
  PrismaDenoSql,
  type SqlDriverAdapter,
} from "../src/server/prisma-adapter/mod.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !(await denoSqlHasColumns())
  ? "needs Deno.SQL result columns (denext's Deno runtime 3.0.0-rc.1+)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const SCHEMA = `prisma_adapter_${crypto.randomUUID().slice(0, 8)}`;

const scalar = (scalarType: ArgType["scalarType"], dbType?: string): ArgType => ({
  scalarType,
  arity: "scalar",
  ...(dbType ? { dbType } : {}),
});
const list = (scalarType: ArgType["scalarType"], dbType?: string): ArgType => ({
  ...scalar(scalarType, dbType),
  arity: "list",
});

/** One row of the matrix: a column declaration, a value written to it, what Prisma reads. */
interface Case {
  name: string;
  decl: string;
  /** The value, as Prisma passes it, and its type; or a SQL literal to insert instead. */
  arg?: unknown;
  argType?: ArgType;
  literal?: string;
  /** The placeholder (`$1::mood` for a cast), default `$1`. */
  param?: string;
  type: number;
  value: unknown;
}

const CASES: Case[] = [
  { name: "int2", decl: "int2", arg: -7, argType: scalar("int"), type: T.Int32, value: -7 },
  {
    name: "int4",
    decl: "int4",
    arg: 2147483647,
    argType: scalar("int"),
    type: T.Int32,
    value: 2147483647,
  },
  {
    name: "int8 beyond 2^53",
    decl: "int8",
    arg: "9007199254740993",
    argType: scalar("bigint"),
    type: T.Int64,
    value: "9007199254740993",
  },
  {
    name: "int8 negative",
    decl: "int8",
    arg: "-42",
    argType: scalar("bigint"),
    type: T.Int64,
    value: "-42",
  },
  { name: "float4", decl: "float4", arg: 0.1, argType: scalar("float"), type: T.Float, value: 0.1 },
  {
    name: "float8",
    decl: "float8",
    arg: 2.5e-10,
    argType: scalar("float"),
    type: T.Double,
    value: 2.5e-10,
  },
  { name: "float8 NaN", decl: "float8", literal: "'NaN'", type: T.Double, value: NaN },
  {
    name: "numeric(10,3)",
    decl: "numeric(10,3)",
    arg: "12.3",
    argType: scalar("decimal"),
    type: T.Numeric,
    value: "12.300",
  },
  {
    name: "numeric large",
    decl: "numeric",
    arg: "-123456789012345678901234567890.000000000000000000001",
    argType: scalar("decimal"),
    type: T.Numeric,
    value: "-123456789012345678901234567890.000000000000000000001",
  },
  {
    name: "numeric 0.0001",
    decl: "numeric",
    arg: "0.0001",
    argType: scalar("decimal"),
    type: T.Numeric,
    value: "0.0001",
  },
  { name: "money", decl: "money", literal: "'-1.50'", type: T.Numeric, value: "-1.50" },
  {
    name: "bool",
    decl: "bool",
    arg: true,
    argType: scalar("boolean"),
    type: T.Boolean,
    value: true,
  },
  {
    name: "text",
    decl: "text",
    arg: 'héllo, "world"',
    argType: scalar("string"),
    type: T.Text,
    value: 'héllo, "world"',
  },
  {
    name: "varchar(20)",
    decl: "varchar(20)",
    arg: "v",
    argType: scalar("string"),
    type: T.Text,
    value: "v",
  },
  {
    name: "char(3)",
    decl: "char(3)",
    arg: "a",
    argType: scalar("string"),
    type: T.Text,
    value: "a  ",
  },
  {
    name: "date",
    decl: "date",
    arg: "2024-02-29T00:00:00.000Z",
    argType: scalar("datetime", "DATE"),
    type: T.Date,
    value: "2024-02-29",
  },
  { name: "date infinity", decl: "date", literal: "'infinity'", type: T.Date, value: "infinity" },
  {
    name: "time(3)",
    decl: "time(3)",
    arg: "1970-01-01T13:14:15.678Z",
    argType: scalar("datetime", "TIME"),
    type: T.Time,
    value: "13:14:15.678",
  },
  { name: "timetz", decl: "timetz", literal: "'08:09:10+02'", type: T.Time, value: "08:09:10" },
  {
    name: "timestamp(3)",
    decl: "timestamp(3)",
    arg: "2024-01-15T12:34:56.789Z",
    argType: scalar("datetime"),
    type: T.DateTime,
    value: "2024-01-15T12:34:56.789+00:00",
  },
  {
    // A wall-clock time US time zones skip (DST): read exactly, whatever the process's TZ.
    name: "timestamp in a DST gap",
    decl: "timestamp(3)",
    arg: "2024-03-10T02:30:00.123Z",
    argType: scalar("datetime"),
    type: T.DateTime,
    value: "2024-03-10T02:30:00.123+00:00",
  },
  {
    name: "timestamp(6) before 2000",
    decl: "timestamp(6)",
    literal: "'1969-07-20 20:17:40.123456'",
    type: T.DateTime,
    value: "1969-07-20T20:17:40.123456+00:00",
  },
  {
    name: "timestamptz",
    decl: "timestamptz(3)",
    arg: "2024-06-01T10:00:00.500Z",
    argType: scalar("datetime"),
    type: T.DateTime,
    value: "2024-06-01T10:00:00.5+00:00",
  },
  {
    name: "json",
    decl: "json",
    arg: '{"a":[1,2]}',
    argType: scalar("json"),
    type: T.Json,
    value: '{"a":[1,2]}',
  },
  {
    name: "jsonb",
    decl: "jsonb",
    arg: '{"b":"x"}',
    argType: scalar("json"),
    type: T.Json,
    value: '{"b": "x"}',
  },
  {
    name: "jsonb string",
    decl: "jsonb",
    arg: '"s"',
    argType: scalar("json"),
    type: T.Json,
    value: '"s"',
  },
  {
    name: "bytea",
    decl: "bytea",
    arg: "AQL/",
    argType: scalar("bytes"),
    type: T.Bytes,
    value: [1, 2, 255],
  },
  {
    name: "uuid",
    decl: "uuid",
    arg: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    argType: scalar("uuid"),
    type: T.Uuid,
    value: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  },
  {
    name: "inet",
    decl: "inet",
    arg: "10.1.2.3",
    argType: scalar("string"),
    param: "$1::inet",
    type: T.Text,
    value: "10.1.2.3",
  },
  {
    name: "inet v6",
    decl: "inet",
    literal: "'2001:db8::1/64'",
    type: T.Text,
    value: "2001:db8::1/64",
  },
  { name: "cidr", decl: "cidr", literal: "'10.0.0.0/8'", type: T.Text, value: "10.0.0.0/8" },
  { name: "bit(3)", decl: "bit(3)", literal: "B'101'", type: T.Text, value: "101" },
  { name: "varbit", decl: "varbit", literal: "B'1100110011'", type: T.Text, value: "1100110011" },
  { name: "xml", decl: "xml", literal: "'<a>1</a>'", type: T.Text, value: "<a>1</a>" },
  { name: "oid", decl: "oid", literal: "4000000000", type: T.Int64, value: 4000000000 },
  {
    name: "enum",
    decl: "mood",
    arg: "happy",
    argType: scalar("enum"),
    param: "CAST($1::text AS mood)",
    type: T.Enum,
    value: "happy",
  },
  {
    name: "domain over int4",
    decl: "posint",
    arg: 5,
    argType: scalar("int"),
    type: T.Int32,
    value: 5,
  },
  {
    name: "int4[]",
    decl: "int4[]",
    arg: [1, null, 3],
    argType: list("int"),
    type: T.Int32Array,
    value: [1, null, 3],
  },
  {
    name: "int4[][]",
    decl: "int4[]",
    literal: "'{{1,2},{3,4}}'",
    type: T.Int32Array,
    value: [[1, 2], [3, 4]],
  },
  {
    name: "empty int4[]",
    decl: "int4[]",
    arg: [],
    argType: list("int"),
    type: T.Int32Array,
    value: [],
  },
  {
    name: "int8[]",
    decl: "int8[]",
    arg: ["9007199254740993", "1"],
    argType: list("bigint"),
    type: T.Int64Array,
    value: ["9007199254740993", "1"],
  },
  {
    name: "float8[]",
    decl: "float8[]",
    arg: [1.5, -2],
    argType: list("float"),
    type: T.DoubleArray,
    value: [1.5, -2],
  },
  {
    name: "numeric[]",
    decl: "numeric[]",
    arg: ["1.10", "2"],
    argType: list("decimal"),
    type: T.NumericArray,
    value: ["1.10", "2"],
  },
  {
    name: "bool[]",
    decl: "bool[]",
    arg: [true, false],
    argType: list("boolean"),
    type: T.BooleanArray,
    value: [true, false],
  },
  {
    name: "text[]",
    decl: "text[]",
    arg: ["a", "b,c", '"q"', null, ""],
    argType: list("string"),
    type: T.TextArray,
    value: ["a", "b,c", '"q"', null, ""],
  },
  {
    name: "jsonb[]",
    decl: "jsonb[]",
    arg: ['{"k":1}', '"s"'],
    argType: list("json"),
    type: T.JsonArray,
    value: ['{"k": 1}', '"s"'],
  },
  {
    name: "bytea[]",
    decl: "bytea[]",
    arg: ["AQ==", "AgM="],
    argType: list("bytes"),
    type: T.BytesArray,
    value: [[1], [2, 3]],
  },
  {
    name: "uuid[]",
    decl: "uuid[]",
    arg: ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"],
    argType: list("uuid"),
    type: T.UuidArray,
    value: ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"],
  },
  {
    name: "date[]",
    decl: "date[]",
    arg: ["2024-01-15T00:00:00.000Z"],
    argType: list("datetime", "DATE"),
    type: T.DateArray,
    value: ["2024-01-15"],
  },
  {
    name: "timestamp(3)[]",
    decl: "timestamp(3)[]",
    arg: ["2024-01-15T12:00:00.000Z", "2024-03-10T02:30:00.000Z"],
    argType: list("datetime"),
    type: T.DateTimeArray,
    value: ["2024-01-15T12:00:00+00:00", "2024-03-10T02:30:00+00:00"],
  },
  {
    name: "enum[]",
    decl: "mood[]",
    arg: ["happy", "sad"],
    argType: list("enum"),
    param: "CAST($1::text[] AS mood[])",
    type: T.EnumArray,
    value: ["happy", "sad"],
  },
];

async function withAdapter(fn: (db: SqlDriverAdapter) => Promise<void>): Promise<void> {
  const db = await new PrismaDenoSql(`${URL_}`).connect();
  try {
    await fn(db);
  } finally {
    await db.dispose();
  }
}

const q = (sql: string, args: unknown[] = [], argTypes: ArgType[] = []) => ({
  sql,
  args,
  argTypes,
});

Deno.test({
  name: `prisma-adapter/postgres: the type round-trip matrix${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    await withAdapter(async (db) => {
      await db.executeScript(`
        create schema "${SCHEMA}";
        set search_path to "${SCHEMA}";
        create type "${SCHEMA}".mood as enum ('happy', 'sad');
        create domain "${SCHEMA}".posint as int4 check (value > 0);
      `);
      try {
        for (const [i, c] of CASES.entries()) {
          await t.step(`${c.name} → ${c.type}`, async () => {
            const table = `"${SCHEMA}".t${i}`;
            await db.executeScript(
              `create table ${table} (v ${c.decl.replace(/^(mood|posint)/, `"${SCHEMA}".$1`)})`,
            );
            const value = c.literal ??
              (c.param ?? "$1").replace(/\b(mood)\b/g, `"${SCHEMA}".mood`);
            const n = await db.executeRaw(
              q(
                `insert into ${table} (v) values (${value})`,
                c.literal ? [] : [c.arg],
                c.literal ? [] : [c.argType!],
              ),
            );
            assertEquals(n, 1);
            const r = await db.queryRaw(q(`select v from ${table}`));
            assertEquals(r.columnNames, ["v"]);
            assertEquals(r.columnTypes, [c.type]);
            assertEquals(r.rows, [[c.value]]);
          });
        }
        await t.step("null of every type reads null", async () => {
          const r = await db.queryRaw(q("select null::int8 a, null::timestamp b, null::jsonb[] c"));
          assertEquals(r.columnTypes, [T.Int64, T.DateTime, T.JsonArray]);
          assertEquals(r.rows, [[null, null, null]]);
        });
        await t.step("a type Prisma cannot read is UnsupportedNativeDataType", async () => {
          const err = await assertRejects(() => db.queryRaw(q("select interval '1 day' as i")));
          assertEquals((err as { cause: unknown }).cause, {
            kind: "UnsupportedNativeDataType",
            type: "interval",
          });
        });
        await t.step("no rows still reports the columns", async () => {
          const r = await db.queryRaw(q(`select v from "${SCHEMA}".t0 where false`));
          assertEquals([r.columnNames, r.columnTypes, r.rows], [["v"], [T.Int32], []]);
        });
      } finally {
        await db.executeScript(`drop schema "${SCHEMA}" cascade`);
      }
    });
  },
});

Deno.test({
  name: `prisma-adapter/postgres: errors map to Prisma's kinds${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    await withAdapter(async (db) => {
      const s = `${SCHEMA}_e`;
      await db.executeScript(`
        create schema "${s}";
        create table "${s}".p (id int primary key, email text unique not null, code varchar(2));
        create table "${s}".c (id int primary key, pid int not null references "${s}".p (id));
        insert into "${s}".p values (1, 'a@x', null);
      `);
      const kind = async (sql: string) => {
        const err = await assertRejects(() => db.executeRaw(q(sql)));
        return (err as { cause: Record<string, unknown> }).cause;
      };
      try {
        await t.step("unique", async () => {
          const c = await kind(`insert into "${s}".p values (2, 'a@x', null)`);
          assertEquals([c.kind, c.constraint, c.originalCode], [
            "UniqueConstraintViolation",
            { fields: ["email"] },
            "23505",
          ]);
        });
        await t.step("not null", async () => {
          const c = await kind(`insert into "${s}".p values (3, null, null)`);
          assertEquals(c.kind, "NullConstraintViolation");
        });
        await t.step("foreign key", async () => {
          const c = await kind(`insert into "${s}".c values (1, 99)`);
          assertEquals([c.kind, c.constraint], ["ForeignKeyConstraintViolation", {
            index: "c_pid_fkey",
          }]);
        });
        await t.step("length", async () => {
          assertEquals(
            (await kind(`insert into "${s}".p values (4, 'b@x', 'abc')`)).kind,
            "LengthMismatch",
          );
        });
        await t.step("missing table and column", async () => {
          assertEquals(await kind(`select * from "${s}".nope`), {
            kind: "TableDoesNotExist",
            table: `${s}.nope`,
            originalCode: "42P01",
            originalMessage: `relation "${s}.nope" does not exist`,
          });
          assertEquals((await kind(`select nope from "${s}".p`)).kind, "ColumnNotFound");
        });
        await t.step("anything else carries the SQLSTATE", async () => {
          const c = await kind("select 1/0");
          assertEquals([c.kind, c.code], ["postgres", "22012"]);
        });
      } finally {
        await db.executeScript(`drop schema "${s}" cascade`);
      }
    });
    await t.step("an unreachable server is DatabaseNotReachable", async () => {
      const db = await new PrismaDenoSql(
        "postgres://u:p@127.0.0.1:1/x?sslmode=disable&connect_timeout=3",
      )
        .connect();
      try {
        const err = await assertRejects(() => db.queryRaw(q("select 1")));
        const c = (err as { cause: Record<string, unknown> }).cause;
        assertEquals([c.kind, c.host, c.port], ["DatabaseNotReachable", "127.0.0.1", 1]);
      } finally {
        await db.dispose();
      }
    });
  },
});

Deno.test({
  name: `prisma-adapter/postgres: transactions, scripts, schema, shadow database${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    const s = `${SCHEMA}_t`;
    await withAdapter(async (db) => {
      await db.executeScript(`
        create schema "${s}";
        create table "${s}".n (v int);
        create function "${s}".twice(x int) returns int language plpgsql as $$
          begin return x * 2; end;
        $$;
      `);
      try {
        await t.step("a script with semicolons inside a function body runs whole", async () => {
          const r = await db.queryRaw(q(`select "${s}".twice(21) as v`));
          assertEquals(r.rows, [[42]]);
        });
        await t.step("commit keeps the rows; Prisma sends COMMIT itself", async () => {
          const tx = await db.startTransaction("SERIALIZABLE");
          assertEquals(tx.options, { usePhantomQuery: false });
          await tx.executeRaw(q(`insert into "${s}".n values (1)`));
          const level = await tx.queryRaw(q("show transaction_isolation"));
          assertEquals(level.rows, [["serializable"]]);
          await tx.executeRaw(q("COMMIT"));
          await tx.commit();
          assertEquals((await db.queryRaw(q(`select count(*)::int from "${s}".n`))).rows, [[1]]);
        });
        await t.step("rollback drops them", async () => {
          const tx = await db.startTransaction();
          await tx.executeRaw(q(`insert into "${s}".n values (2)`));
          await tx.executeRaw(q("ROLLBACK"));
          await tx.rollback();
          assertEquals((await db.queryRaw(q(`select count(*)::int from "${s}".n`))).rows, [[1]]);
        });
        await t.step("SNAPSHOT is refused", async () => {
          const err = await assertRejects(() => db.startTransaction("SNAPSHOT"));
          assertEquals((err as { cause: unknown }).cause, {
            kind: "InvalidIsolationLevel",
            level: "SNAPSHOT",
          });
        });
        await t.step(
          "transactions release their connections (more than the pool holds)",
          async () => {
            for (let i = 0; i < 25; i++) {
              const tx = await db.startTransaction();
              await tx.executeRaw(q("ROLLBACK"));
              await tx.rollback();
            }
          },
        );
      } finally {
        await db.executeScript(`drop schema "${s}" cascade`);
      }
    });
    await t.step("the URL's schema parameter is the search_path", async () => {
      const url = new URL(URL_!);
      url.searchParams.set("schema", "information_schema");
      const db = await new PrismaDenoSql(url).connect();
      try {
        assertEquals((await db.queryRaw(q("select current_schema()::text"))).rows, [[
          "information_schema",
        ]]);
        assertEquals(db.getConnectionInfo?.(), {
          schemaName: "information_schema",
          supportsRelationJoins: true,
        });
      } finally {
        await db.dispose();
      }
    });
    await t.step("a shadow database is created and dropped", async () => {
      const factory = new PrismaDenoSql(URL_!);
      const shadow = await factory.connectToShadowDb();
      const name = (await shadow.queryRaw(q("select current_database()::text")))
        .rows[0][0] as string;
      assert(name.startsWith("prisma_migrate_shadow_db_"));
      await shadow.dispose();
      const db = await factory.connect();
      try {
        const left = await db.queryRaw(
          q("select count(*)::int from pg_database where datname = $1", [name], [
            scalar("string"),
          ]),
        );
        assertEquals(left.rows, [[0]]);
      } finally {
        await db.dispose();
      }
    });
  },
});
