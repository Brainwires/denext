// `denext ui` → Database: the SQL builders (src/ui/database/sql.ts). Identifiers come only from
// the catalog entry and are quoted (an embedded quote doubled); every value is a `$n` parameter
// cast to its column's type; paging is keyset on the primary key (the sort column first, NULLs
// last); writes refuse what Postgres would refuse or what the admin must not do (a view, a table
// without a key, a generated or GENERATED ALWAYS column, an over-long value).

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columnOf,
  cursorAfter,
  DbSqlError,
  deleteRow,
  enableRlsMigration,
  insertRow,
  qualifiedName,
  quoteIdent,
  selectPage,
  selectRow,
  updateRow,
} from "../src/ui/database/sql.ts";
import { type DbColumn, type DbTableInfo, maskSecrets } from "../src/ui/database/protocol.ts";
import { actorClaims, displayTarget } from "../src/cli/db-admin/connection.ts";
import { userClaims } from "../packages/backend/src/rls.ts";

/** A column. */
function col(name: string, castType = "text", over: Partial<DbColumn> = {}): DbColumn {
  return {
    name,
    type: castType,
    castType,
    nullable: true,
    default: null,
    identity: null,
    generated: false,
    ...over,
  };
}

/** A table: `public.notes (id bigint pk, title text, "we""ird" text, owner uuid)`. */
const NOTES: DbTableInfo = {
  schema: "public",
  name: "notes",
  kind: "table",
  estimate: 3,
  rls: false,
  forced: false,
  hasPrimaryKey: true,
  columns: [
    col("id", "bigint", { nullable: false, identity: "by default" }),
    col("title"),
    col('we"ird'),
    col("owner", "uuid"),
    col("slug", "text", { generated: true }),
  ],
  primaryKey: ["id"],
  indexes: [],
  foreignKeys: [],
  policies: [],
};

/** A table with a two-column key and an identity ALWAYS column. */
const PAIRS: DbTableInfo = {
  ...NOTES,
  name: "pairs",
  columns: [
    col("a", "integer", { nullable: false }),
    col("b", "text", { nullable: false }),
    col("n", "integer", { identity: "always" }),
  ],
  primaryKey: ["a", "b"],
};

Deno.test("quoteIdent doubles embedded quotes and refuses empty/NUL names", () => {
  assertEquals(quoteIdent("notes"), '"notes"');
  assertEquals(quoteIdent('a"b'), '"a""b"');
  assertEquals(quoteIdent('x"; DROP TABLE t; --'), '"x""; DROP TABLE t; --"');
  assertThrows(() => quoteIdent(""), DbSqlError);
  assertThrows(() => quoteIdent("a\0b"), DbSqlError);
  assertEquals(qualifiedName({ schema: "my schema", name: 'n"' }), '"my schema"."n"""');
});

Deno.test("columnOf is the whitelist: a name the catalog lacks is refused", () => {
  assertEquals(columnOf(NOTES, "title").name, "title");
  assertThrows(() => columnOf(NOTES, "title; DROP TABLE notes"), DbSqlError, "no column");
  assertThrows(() => selectPage(NOTES, { sort: "nope" }), DbSqlError);
  assertThrows(() => selectPage(NOTES, { filter: { column: "nope", value: "x" } }), DbSqlError);
});

Deno.test("selectPage: the first page reads every column as text, key order, one extra row", () => {
  const page = selectPage(NOTES, { limit: 10 });
  assertEquals(
    page.text,
    'SELECT "id"::text AS "id", left("title"::text, 201) AS "title", ' +
      'left("we""ird"::text, 201) AS "we""ird", left("owner"::text, 201) AS "owner", ' +
      'left("slug"::text, 201) AS "slug" FROM "public"."notes" ORDER BY "public"."notes"."id" ASC ' +
      "LIMIT 11",
  );
  assertEquals(page.params, []);
});

Deno.test("selectPage: keyset on the key, cast to its type; descending flips the comparison", () => {
  const asc = selectPage(NOTES, { after: ["42"], limit: 5 });
  assertStringIncludes(
    asc.text,
    'WHERE ("id") > ($1::bigint) ORDER BY "public"."notes"."id" ASC LIMIT 6',
  );
  assertEquals(asc.params, ["42"]);
  const desc = selectPage(NOTES, { after: ["42"], direction: "desc" });
  assertStringIncludes(
    desc.text,
    'WHERE ("id") < ($1::bigint) ORDER BY "public"."notes"."id" DESC',
  );
  // Sorting by the sole key column is key order.
  assertEquals(selectPage(NOTES, { sort: "id", after: ["1"] }).params, ["1"]);
});

Deno.test("selectPage: a composite key compares as a row", () => {
  const page = selectPage(PAIRS, { after: ["1", "x"] });
  assertStringIncludes(
    page.text,
    'WHERE ("a", "b") > ($1::integer, $2::text) ORDER BY "public"."pairs"."a" ASC, "public"."pairs"."b" ASC',
  );
  assertEquals(page.params, ["1", "x"]);
});

Deno.test("selectPage: a sort column comes first, NULLs last, the key breaking ties", () => {
  const first = selectPage(NOTES, { sort: "title" });
  // The sort column is read whole (the cursor is built from it); the others are cut in SQL.
  assertStringIncludes(first.text, '"title"::text AS "title", left("we""ird"::text, 201)');
  assertStringIncludes(
    first.text,
    'ORDER BY "public"."notes"."title" ASC NULLS LAST, "public"."notes"."id" ASC',
  );
  const next = selectPage(NOTES, { sort: "title", after: ["b", "7"] });
  assertStringIncludes(
    next.text,
    'WHERE ("title" > $2::text OR ("title" = $2::text AND ("id") > ($1::bigint)) OR "title" IS NULL)',
  );
  assertEquals(next.params, ["7", "b"]);
  // Past the non-NULL values, the NULLs are paged by key alone.
  const nulls = selectPage(NOTES, { sort: "title", after: [null, "7"] });
  assertStringIncludes(nulls.text, 'WHERE ("title" IS NULL AND ("id") > ($1::bigint))');
  assertEquals(nulls.params, ["7"]);
});

Deno.test("selectPage: a filter binds its value (or tests IS NULL) before the keyset", () => {
  const page = selectPage(NOTES, { filter: { column: "owner", value: "u1" }, after: ["3"] });
  assertStringIncludes(page.text, 'WHERE "owner" = $1::uuid AND ("id") > ($2::bigint)');
  assertEquals(page.params, ["u1", "3"]);
  const isNull = selectPage(NOTES, { filter: { column: "title", value: null } });
  assertStringIncludes(isNull.text, 'WHERE "title" IS NULL ORDER BY');
});

Deno.test("selectPage refuses a cursor that does not fit, and paging a keyless table", () => {
  assertThrows(() => selectPage(NOTES, { after: ["1", "2"] }), DbSqlError, "does not fit");
  assertThrows(() => selectPage(NOTES, { after: [null] }), DbSqlError, "never NULL");
  const keyless = { ...NOTES, primaryKey: [], hasPrimaryKey: false };
  assertEquals(selectPage(keyless).text.endsWith('FROM "public"."notes" LIMIT 51'), true);
  assertThrows(() => selectPage(keyless, { after: ["1"] }), DbSqlError, "no primary key");
  assertThrows(() => selectPage(NOTES, { limit: 0 }), DbSqlError, "page size");
});

Deno.test("cursorAfter takes the sort value then the key", () => {
  const row = { id: "9", title: null, 'we"ird': "w", owner: "o", slug: "s" };
  assertEquals(cursorAfter(NOTES, row), ["9"]);
  assertEquals(cursorAfter(NOTES, row, "title"), [null, "9"]);
  assertEquals(cursorAfter(PAIRS, { a: "1", b: "x", n: "3" }, "n"), ["3", "1", "x"]);
});

Deno.test("selectRow / updateRow / deleteRow address exactly the key", () => {
  assertEquals(selectRow(NOTES, { id: "5" }), {
    text: 'SELECT "id"::text AS "id", left("title"::text, 65537) AS "title", ' +
      'left("we""ird"::text, 65537) AS "we""ird", left("owner"::text, 65537) AS "owner", ' +
      'left("slug"::text, 65537) AS "slug" FROM "public"."notes" WHERE "id" = $1::bigint LIMIT 1',
    params: ["5"],
  });
  assertEquals(updateRow(NOTES, { id: "5" }, { title: "new", owner: null }, 100), {
    text: 'UPDATE "public"."notes" SET "title" = $1::text, "owner" = $2::uuid ' +
      'WHERE "id" = $3::bigint RETURNING "id"::text',
    params: ["new", null, "5"],
  });
  assertEquals(deleteRow(PAIRS, { a: "1", b: "x" }), {
    text: 'DELETE FROM "public"."pairs" WHERE "a" = $1::integer AND "b" = $2::text ' +
      'RETURNING "a"::text, "b"::text',
    params: ["1", "x"],
  });
  assertThrows(() => deleteRow(PAIRS, { a: "1" }), DbSqlError, "exactly the primary key");
  assertThrows(() => deleteRow(NOTES, { title: "x" }), DbSqlError, "exactly the primary key");
  assertThrows(() => updateRow(NOTES, { id: "5" }, {}, 100), DbSqlError, "nothing to update");
});

Deno.test("insertRow: listed columns bound, the rest DEFAULT; DEFAULT VALUES when none", () => {
  assertEquals(insertRow(NOTES, { title: "t", owner: null }, 100), {
    text: 'INSERT INTO "public"."notes" ("title", "owner") VALUES ($1::text, $2::uuid) ' +
      'RETURNING "id"::text',
    params: ["t", null],
  });
  assertEquals(
    insertRow(NOTES, {}, 100).text,
    'INSERT INTO "public"."notes" DEFAULT VALUES RETURNING "id"::text',
  );
});

Deno.test("writes refuse views, keyless tables, generated / identity-always columns, long values", () => {
  assertThrows(() => insertRow({ ...NOTES, kind: "view" }, {}, 10), DbSqlError, "only tables");
  assertThrows(
    () => deleteRow({ ...NOTES, primaryKey: [] }, { id: "1" }),
    DbSqlError,
    "no primary key",
  );
  assertThrows(() => updateRow(NOTES, { id: "1" }, { slug: "x" }, 10), DbSqlError, "generated");
  assertThrows(() => insertRow(PAIRS, { n: "1" }, 10), DbSqlError, "identity");
  assertThrows(() => insertRow(NOTES, { title: "x".repeat(11) }, 10), DbSqlError, "longer");
  assertThrows(() => updateRow(NOTES, { id: "1" }, { nope: "x" }, 10), DbSqlError, "no column");
});

Deno.test("enableRlsMigration quotes the table and enables (never forces) RLS", () => {
  const sql = enableRlsMigration({ schema: "app", name: 'odd"name' });
  assertStringIncludes(sql, 'ALTER TABLE "app"."odd""name" ENABLE ROW LEVEL SECURITY;');
  assertEquals(sql.includes("FORCE"), false);
});

Deno.test("maskSecrets and displayTarget never print a password", () => {
  assertEquals(
    maskSecrets("connect postgres://app:s3cr3t@db:5432/x failed"),
    "connect postgres://app:•••@db:5432/x failed",
  );
  assertEquals(maskSecrets("postgresql://u:p@h/d"), "postgresql://u:•••@h/d");
  assertEquals(
    displayTarget("postgres://app:s3cr3t@db:5432/x?sslmode=require").includes("s3cr3t"),
    false,
  );
  assertEquals(displayTarget("postgres://app:s3cr3t@db:5432/x"), "postgres://app:•••@db:5432/x");
  assertEquals(displayTarget("postgres://db/x"), "postgres://db/x");
  assertStringIncludes(displayTarget(undefined), "sql");
  assertEquals(displayTarget("postgres://a:b@[bad").includes(":b@"), false);
});

Deno.test("actorClaims sends the claims @denext/backend's db({ as: user }) sends", () => {
  assertEquals(actorClaims({ kind: "service" }), null);
  assertEquals(actorClaims({ kind: "anon" }), { role: "anon", claims: '{"role":"anon"}' });
  const mine = actorClaims({ kind: "user", id: "u1", email: "a@b.c" });
  assertEquals(mine?.role, "authenticated");
  assertEquals(JSON.parse(mine!.claims), userClaims({ id: "u1", email: "a@b.c" }));
  assertEquals(
    JSON.parse(actorClaims({ kind: "user", id: "u2" })!.claims),
    userClaims({ id: "u2" }),
  );
  assertThrows(() => actorClaims({ kind: "user", id: "" }), TypeError);
});
