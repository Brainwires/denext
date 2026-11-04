// `denext/prisma-adapter` on SQLite (`Deno.SQL`, in memory and on a file): every declared
// column type Prisma creates makes the round trip with Prisma's argument forms, columns with no
// declared type take their values' type, errors map to Prisma's kinds, and transactions,
// scripts and the shadow database work.
//
// Ignored on a runtime whose Deno.SQL reports no result columns (before denext's Deno runtime
// 3.0.0-rc.1).

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  type ArgType,
  ColumnTypeEnum as T,
  denoSqlHasColumns,
  PrismaDenoSql,
  type SqlDriverAdapter,
} from "../src/server/prisma-adapter/mod.ts";

const reason = (await denoSqlHasColumns())
  ? undefined
  : "needs Deno.SQL result columns (denext's Deno runtime 3.0.0-rc.1+)";
const label = reason ? ` (skipped: ${reason})` : "";

const arg = (scalarType: ArgType["scalarType"]): ArgType => ({ scalarType, arity: "scalar" });
const q = (sql: string, args: unknown[] = [], argTypes: ArgType[] = []) => ({
  sql,
  args,
  argTypes,
});

interface Case {
  name: string;
  decl: string;
  arg: unknown;
  argType: ArgType;
  type: number;
  value: unknown;
}

// The declared types Prisma's SQLite migrations write, and what each reads back as.
const CASES: Case[] = [
  { name: "Int", decl: "INTEGER", arg: 42, argType: arg("int"), type: T.Int32, value: 42 },
  {
    name: "Int from a string",
    decl: "INTEGER",
    arg: "7",
    argType: arg("int"),
    type: T.Int32,
    value: 7,
  },
  {
    name: "BigInt beyond 2^53",
    decl: "BIGINT",
    arg: "9007199254740993",
    argType: arg("bigint"),
    type: T.Int64,
    value: "9007199254740993",
  },
  { name: "Float", decl: "REAL", arg: 1.25, argType: arg("float"), type: T.Double, value: 1.25 },
  {
    name: "Decimal",
    decl: "DECIMAL",
    arg: "12.5",
    argType: arg("decimal"),
    type: T.Numeric,
    value: 12.5,
  },
  {
    name: "Boolean",
    decl: "BOOLEAN",
    arg: true,
    argType: arg("boolean"),
    type: T.Boolean,
    value: 1,
  },
  {
    name: "String",
    decl: "TEXT",
    arg: "héllo",
    argType: arg("string"),
    type: T.Text,
    value: "héllo",
  },
  {
    name: "varchar(20)",
    decl: "varchar(20)",
    arg: "v",
    argType: arg("string"),
    type: T.Text,
    value: "v",
  },
  {
    name: "DateTime",
    decl: "DATETIME",
    arg: "2024-03-10T02:30:00.123Z",
    argType: arg("datetime"),
    type: T.DateTime,
    value: "2024-03-10T02:30:00.123+00:00",
  },
  {
    name: "Bytes",
    decl: "BLOB",
    arg: "AQL/",
    argType: arg("bytes"),
    type: T.Bytes,
    value: [1, 2, 255],
  },
  {
    name: "Json",
    decl: "JSONB",
    arg: '{"a":1}',
    argType: arg("json"),
    type: T.Json,
    value: '{"a":1}',
  },
  {
    name: "DATE",
    decl: "DATE",
    arg: "2024-01-15",
    argType: arg("string"),
    type: T.Date,
    value: "2024-01-15",
  },
  {
    name: "TIME",
    decl: "TIME",
    arg: "12:00:00",
    argType: arg("string"),
    type: T.Time,
    value: "12:00:00",
  },
];

async function withAdapter(
  fn: (db: SqlDriverAdapter) => Promise<void>,
  url = ":memory:",
): Promise<void> {
  const db = await new PrismaDenoSql(url).connect();
  try {
    await fn(db);
  } finally {
    await db.dispose();
  }
}

Deno.test({
  name: `prisma-adapter/sqlite: the type round-trip matrix${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    await withAdapter(async (db) => {
      for (const [i, c] of CASES.entries()) {
        await t.step(`${c.name} (${c.decl}) → ${c.type}`, async () => {
          await db.executeScript(`create table t${i} (v ${c.decl})`);
          assertEquals(
            await db.executeRaw(q(`insert into t${i} (v) values (?)`, [c.arg], [c.argType])),
            1,
          );
          const r = await db.queryRaw(q(`select v from t${i}`));
          assertEquals([r.columnNames, r.columnTypes, r.rows], [["v"], [c.type], [[c.value]]]);
        });
      }
      await t.step("expressions take their values' type", async () => {
        const r = await db.queryRaw(
          q("select 1.5 as f, 'x' as s, x'00ff' as b, 9007199254740993 as n, null as z, ? as i", [
            3,
          ], [arg("int")]),
        );
        assertEquals(r.columnTypes, [T.UnknownNumber, T.Text, T.Bytes, T.Int64, T.Int32, T.Int64]);
        assertEquals(r.rows, [[1.5, "x", [0, 255], "9007199254740993", null, "3"]]);
      });
      await t.step("an integer column truncates a stored fraction", async () => {
        await db.executeScript("create table f (v INTEGER); insert into f values (2.75)");
        assertEquals((await db.queryRaw(q("select v from f"))).rows, [[2]]);
      });
      await t.step("an INSERT reports its rowid; a SELECT does not", async () => {
        await db.executeScript("create table r (id INTEGER PRIMARY KEY, v TEXT)");
        const ins = await db.queryRaw(q("insert into r (v) values ('a') returning id", []));
        assertEquals([ins.rows, ins.lastInsertId], [[[1]], "1"]);
        assertEquals((await db.queryRaw(q("select id from r"))).lastInsertId, undefined);
      });
    });
  },
});

Deno.test({
  name: `prisma-adapter/sqlite: unixepoch-ms timestamps${label}`,
  ignore: reason !== undefined,
  async fn() {
    const db = await new PrismaDenoSql(":memory:", { timestampFormat: "unixepoch-ms" }).connect();
    try {
      await db.executeScript("create table d (v DATETIME)");
      await db.executeRaw(
        q("insert into d values (?)", ["2024-01-15T12:00:00.000Z"], [arg("datetime")]),
      );
      assertEquals((await db.queryRaw(q("select v from d"))).rows, [["2024-01-15T12:00:00.000Z"]]);
    } finally {
      await db.dispose();
    }
  },
});

Deno.test({
  name: `prisma-adapter/sqlite: errors map to Prisma's kinds${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    await withAdapter(async (db) => {
      await db.executeScript(`
        create table p (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
        create table c (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p (id));
        insert into p values (1, 'a@x');
      `);
      const cause = async (sql: string) =>
        ((await assertRejects(() => db.executeRaw(q(sql)))) as { cause: Record<string, unknown> })
          .cause;
      await t.step("unique", async () => {
        assertEquals(await cause("insert into p values (2, 'a@x')"), {
          kind: "UniqueConstraintViolation",
          constraint: { fields: ["email"] },
          table: "p",
          originalCode: "SQLITE_CONSTRAINT_UNIQUE",
          originalMessage: "UNIQUE constraint failed: p.email",
        });
      });
      await t.step("primary key", async () => {
        const c = await cause("insert into p values (1, 'b@x')");
        assertEquals([c.kind, c.constraint, c.table], [
          "UniqueConstraintViolation",
          { fields: ["id"] },
          "p",
        ]);
      });
      await t.step("not null", async () => {
        const c = await cause("insert into p values (3, null)");
        assertEquals([c.kind, c.constraint], ["NullConstraintViolation", { fields: ["email"] }]);
      });
      await t.step("foreign key", async () => {
        assertEquals(
          (await cause("insert into c values (1, 99)")).kind,
          "ForeignKeyConstraintViolation",
        );
      });
      await t.step("missing table and column", async () => {
        const table = await cause("select * from nope");
        assertEquals([table.kind, table.table], ["TableDoesNotExist", "nope"]);
        const column = await cause("select nope from p");
        assertEquals([column.kind, column.column], ["ColumnNotFound", "nope"]);
        const named = await cause("insert into p (nope) values (1)");
        assertEquals([named.kind, named.column], ["ColumnNotFound", "nope"]);
      });
      await t.step("anything else carries SQLite's extended code", async () => {
        const c = await cause("select * from");
        assertEquals([c.kind, c.extendedCode], ["sqlite", 1]);
      });
    });
  },
});

Deno.test({
  name: `prisma-adapter/sqlite: transactions, scripts and the shadow database${label}`,
  ignore: reason !== undefined,
  async fn(t) {
    const dir = await Deno.makeTempDir();
    const url = `file:${join(dir, "dev.db")}`;
    try {
      await withAdapter(async (db) => {
        await db.executeScript("create table n (v INTEGER); create table m (v INTEGER);");
        await t.step("commit keeps the rows", async () => {
          const tx = await db.startTransaction("SERIALIZABLE");
          await tx.executeRaw(q("insert into n values (1)"));
          await tx.executeRaw(q("COMMIT"));
          await tx.commit();
          assertEquals((await db.queryRaw(q("select count(*) as c from n"))).rows, [["1"]]);
        });
        await t.step("rollback drops them", async () => {
          const tx = await db.startTransaction();
          await tx.executeRaw(q("insert into n values (2)"));
          await tx.executeRaw(q("ROLLBACK"));
          await tx.rollback();
          assertEquals((await db.queryRaw(q("select count(*) as c from n"))).rows, [["1"]]);
        });
        await t.step("a failed COMMIT still frees the connection", async () => {
          const tx = await db.startTransaction();
          await tx.executeRaw(q("ROLLBACK"));
          await assertRejects(() => tx.executeRaw(q("COMMIT")));
          assertEquals((await db.queryRaw(q("select count(*) as c from n"))).rows, [["1"]]);
        });
        await t.step("only SERIALIZABLE is accepted", async () => {
          const err = await assertRejects(() => db.startTransaction("READ COMMITTED"));
          assertEquals((err as { cause: unknown }).cause, {
            kind: "InvalidIsolationLevel",
            level: "READ COMMITTED",
          });
        });
        await t.step("connection info", () => {
          assertEquals(db.getConnectionInfo?.(), { supportsRelationJoins: false });
        });
      }, url);
      await t.step("the file keeps the committed rows", async () => {
        await withAdapter(async (db) => {
          assertEquals((await db.queryRaw(q("select v from n"))).rows, [[1]]);
        }, url);
      });
      await t.step("the shadow database is in memory", async () => {
        const shadow = await new PrismaDenoSql(url).connectToShadowDb();
        try {
          assertEquals((await shadow.queryRaw(q("select count(*) as c from sqlite_master"))).rows, [
            ["0"],
          ]);
        } finally {
          await shadow.dispose();
        }
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
