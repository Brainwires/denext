// `@denext/backend` auto-REST: the statement builder. Every identifier passes the catalog
// whitelist and is quoted; every value is a `$n` parameter (filters cast to the column's type,
// bodies one `$n::json` expanded against the table's row type); PATCH / DELETE without a filter,
// unknown columns and operators, embedded resources and generated columns are refused. Also the
// row types `.denext/rest.ts` is generated with.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { RestColumn, RestTable } from "../packages/backend/src/rest-catalog.ts";
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  columnOf,
  countParam,
  MAX_IN_VALUES,
  parseInList,
  quoteIdent,
  RestError,
  selectListOf,
} from "../packages/backend/src/rest-query.ts";
import { columnType, generateRestTypes } from "../packages/backend/src/rest-codegen.ts";
import { statusForSqlState } from "../packages/backend/src/rest.ts";

function col(name: string, castType: string, extra: Partial<RestColumn> = {}): RestColumn {
  return {
    name,
    castType,
    typeName: castType,
    category: "S",
    nullable: false,
    hasDefault: false,
    readOnly: false,
    ...extra,
  };
}

const notes: RestTable = {
  schema: "public",
  name: "notes",
  kind: "table",
  primaryKey: ["id"],
  columns: [
    col("id", "integer", { typeName: "int4", category: "N", hasDefault: true }),
    col("owner", "uuid", { typeName: "uuid", category: "U" }),
    col("body", "text"),
    col("done", "boolean", { typeName: "bool", category: "B", hasDefault: true }),
    col("tags", "text[]", {
      typeName: "_text",
      category: "A",
      element: { typeName: "text", category: "S" },
      nullable: true,
    }),
    col("meta", "jsonb", { typeName: "jsonb", category: "U", nullable: true }),
    col("mood", "mood", { typeName: "mood", category: "E", enumLabels: ["ok", "sad"] }),
    col("size", "integer", { typeName: "int4", category: "N", readOnly: true }),
    col('we"ird', "text", { nullable: true }),
  ],
};

const q = (s: string) => new URLSearchParams(s);
const page = { offset: 0, limit: 1000, count: false };

/** The refusal `fn` throws. */
function refusal(fn: () => unknown): RestError {
  return assertThrows(fn, RestError) as RestError;
}

Deno.test("buildSelect: columns, filters as typed parameters, order, limit and offset", () => {
  const st = buildSelect(
    notes,
    q("select=id,body&id=gte.5&body=like.a*b&done=is.false&order=id.desc.nullslast,body"),
    { offset: 10, limit: 20, count: false },
  );
  assertEquals(
    st.text,
    `SELECT coalesce(json_agg(_r), '[]')::text AS body, count(*)::text AS n FROM (` +
      `SELECT "id", "body" FROM "public"."notes" WHERE "id" >= $1::integer AND ` +
      `"body" LIKE $2::text AND "done" IS FALSE ORDER BY "id" DESC NULLS LAST, "body" ` +
      `LIMIT 20 OFFSET 10) _r`,
  );
  assertEquals(st.params, ["5", "a%b"]);
});

Deno.test("buildSelect: * by default; count=exact counts with the same filters", () => {
  const st = buildSelect(notes, q("owner=eq.u1"), { ...page, count: true });
  assertStringIncludes(st.text, `SELECT * FROM "public"."notes" WHERE "owner" = $1::uuid`);
  assertStringIncludes(
    st.text,
    `(SELECT count(*) FROM "public"."notes" WHERE "owner" = $1::uuid)::text AS total`,
  );
  assertEquals(st.params, ["u1"]);
});

Deno.test("every operator, not., in-lists with quotes, and array-typed columns", () => {
  const st = buildSelect(
    notes,
    q(
      'id=neq.1&id=gt.2&id=lt.9&id=lte.8&body=ilike.*x*&body=not.eq.y&id=in.(1,2)&body=in.("a,b","c\\"d")&tags=eq.{a,b}&meta=is.null&id=in.()',
    ),
    page,
  );
  assertStringIncludes(st.text, `"id" <> $1::integer AND "id" > $2::integer`);
  assertStringIncludes(st.text, `"id" < $3::integer AND "id" <= $4::integer`);
  assertStringIncludes(st.text, `"body" ILIKE $5::text AND NOT ("body" = $6::text)`);
  assertStringIncludes(st.text, `"id" IN ($7::integer, $8::integer)`);
  assertStringIncludes(st.text, `"body" IN ($9::text, $10::text)`);
  assertStringIncludes(st.text, `"tags" = $11::text[] AND "meta" IS NULL AND FALSE`);
  assertEquals(st.params, ["1", "2", "9", "8", "%x%", "y", "1", "2", "a,b", 'c"d', "{a,b}"]);
});

Deno.test("injection through a value stays a parameter", () => {
  const evil = "1; drop table notes; --";
  const st = buildSelect(notes, q(`body=eq.${encodeURIComponent(evil)}&body=in.(x'),'y)`), page);
  assert(!st.text.includes("drop table"));
  assert(!st.text.includes("x'"));
  assertEquals(st.params, [evil, "x')", "'y"]);
});

Deno.test("injection through a column name: unknown columns are refused, catalog names quoted", () => {
  for (
    const attack of [
      `body"; drop table notes; --`,
      "body) or (1=1",
      "Body",
      "notes.body",
      "",
    ]
  ) {
    const e = refusal(() => buildSelect(notes, q(`${encodeURIComponent(attack)}=eq.1`), page));
    assertEquals([e.status, e.code], [400, "42703"]);
    if (attack === "") continue; // an empty select / order is the default, not a column
    refusal(() => buildSelect(notes, q(`select=${encodeURIComponent(attack)}`), page));
    refusal(() => buildSelect(notes, q(`order=${encodeURIComponent(attack)}`), page));
  }
  // A catalog column whose name holds a quote is quoted with the quote doubled.
  assertEquals(quoteIdent('we"ird'), '"we""ird"');
  assertStringIncludes(buildSelect(notes, q('select=we"ird'), page).text, `"we""ird"`);
});

Deno.test("refusals: operators, is values, modifiers, embeds, aliases, unsupported params", () => {
  const cases: Array<[string, string]> = [
    ["id=1", "PGRST100"],
    ["id=regex.x", "PGRST100"],
    ["id=is.maybe", "PGRST100"],
    ["id=in.1,2", "PGRST100"],
    ['id=in.("a', "PGRST100"],
    ['id=in.("a"b)', "PGRST100"],
    ["order=id.sideways", "PGRST100"],
    ["order=id.asc.desc", "PGRST100"],
    ["select=owner(*)", "PGRST100"],
    ["select=alias:body", "PGRST100"],
    ["select=meta->x", "PGRST100"],
    ["or=(id.eq.1)", "PGRST100"],
    ["on_conflict=id", "PGRST100"],
  ];
  for (const [query, code] of cases) {
    const e = refusal(() => buildSelect(notes, q(query), page));
    assertEquals([e.status, e.code], [400, code], query);
  }
  const embed = refusal(() => selectListOf(notes, "id,owner(name)"));
  assertStringIncludes(embed.message, "embedded resources are not supported");
  assert(embed.hint);
  const many = Array.from({ length: 65 }, (_, i) => `id=eq.${i}`).join("&");
  refusal(() => buildSelect(notes, q(many), page));
  refusal(() =>
    parseInList(`(${Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => i).join(",")})`)
  );
  assertEquals(parseInList("()"), []);
  assertEquals(parseInList('(a,"",b c)'), ["a", "", "b c"]);
  assertEquals(parseInList("(a,)"), ["a", ""]);
  assertEquals(parseInList('("x\\\\y","(z)")'), ["x\\y", "(z)"]);
  refusal(() => parseInList('(a"b)'));
  assertEquals(countParam(null, "limit"), undefined);
  assertEquals(countParam("25", "limit"), 25);
  for (const bad of ["-1", "1.5", "x", "1e3", "9999999999"]) {
    refusal(() => countParam(bad, "limit"));
  }
  assertEquals(columnOf(notes, "body").castType, "text");
});

Deno.test("buildInsert: one object or an array, one json parameter over the row type", () => {
  const one = buildInsert(notes, q(""), { owner: "u1", body: "hi" }, { representation: false });
  assertEquals(
    one.text,
    `INSERT INTO "public"."notes" ("owner", "body") SELECT "owner", "body" FROM ` +
      `json_populate_record(NULL::"public"."notes", $1::json)`,
  );
  assertEquals(one.params, [JSON.stringify({ owner: "u1", body: "hi" })]);
  const many = buildInsert(
    notes,
    q("select=id"),
    [{ body: "a", tags: ["x"] }, { tags: null, body: "b" }],
    { representation: true },
  );
  assertEquals(
    many.text,
    `WITH _m AS (INSERT INTO "public"."notes" ("body", "tags") SELECT "body", "tags" FROM ` +
      `json_populate_recordset(NULL::"public"."notes", $1::json) RETURNING "id") ` +
      `SELECT coalesce(json_agg(_m), '[]')::text AS body, count(*)::text AS n FROM _m`,
  );
  assertEquals(JSON.parse(many.params[0]).length, 2);
  const empty = buildInsert(notes, q(""), {}, { representation: true });
  assertStringIncludes(empty.text, `INSERT INTO "public"."notes" DEFAULT VALUES RETURNING *`);
});

Deno.test("buildInsert refusals: shapes, mismatched keys, unknown and generated columns", () => {
  const bad: unknown[] = [null, 1, "x", [], [1], [{ body: "a" }, { owner: "b" }], [{}, {}]];
  for (const body of bad) {
    const e = refusal(() => buildInsert(notes, q(""), body, { representation: false }));
    assertEquals([e.status, e.code], [400, "PGRST102"], JSON.stringify(body));
  }
  assertEquals(
    refusal(() => buildInsert(notes, q(""), { nope: 1 }, { representation: false })).code,
    "42703",
  );
  assertEquals(
    refusal(() => buildInsert(notes, q(""), { size: 1 }, { representation: false })).code,
    "428C9",
  );
  // A key that looks like SQL is just an unknown column.
  const e = refusal(() =>
    buildInsert(notes, q(""), { 'body") values (1); --': "x" }, { representation: false })
  );
  assertEquals(e.code, "42703");
});

Deno.test("buildUpdate: SET from one json parameter, filters after it; no filter is refused", () => {
  const st = buildUpdate(notes, q("id=eq.3&select=id,body"), { body: "new" }, {
    representation: true,
  });
  assertEquals(
    st.text,
    `WITH _m AS (UPDATE "public"."notes" SET ("body") = (SELECT "body" FROM ` +
      `json_populate_record(NULL::"public"."notes", $1::json)) WHERE "id" = $2::integer ` +
      `RETURNING "id", "body") SELECT coalesce(json_agg(_m), '[]')::text AS body, ` +
      `count(*)::text AS n FROM _m`,
  );
  assertEquals(st.params, ['{"body":"new"}', "3"]);
  const none = refusal(() => buildUpdate(notes, q(""), { body: "x" }, { representation: false }));
  assertEquals([none.status, none.code, none.message], [
    400,
    "21000",
    "UPDATE requires a WHERE clause",
  ]);
  // select / order / limit are not filters.
  refusal(() =>
    buildUpdate(notes, q("select=id&order=id&limit=1"), { body: "x" }, { representation: false })
  );
  refusal(() => buildUpdate(notes, q("id=eq.1"), [{ body: "x" }], { representation: false }));
  refusal(() => buildUpdate(notes, q("id=eq.1"), {}, { representation: false }));
  assertEquals(
    refusal(() => buildUpdate(notes, q("id=eq.1"), { size: 2 }, { representation: false })).code,
    "428C9",
  );
});

Deno.test("buildDelete: filters required; representation returns the deleted rows", () => {
  assertEquals(buildDelete(notes, q("owner=eq.u1"), { representation: false }), {
    text: `DELETE FROM "public"."notes" WHERE "owner" = $1::uuid`,
    params: ["u1"],
  });
  assertStringIncludes(
    buildDelete(notes, q("id=in.(1,2)"), { representation: true }).text,
    `RETURNING *) SELECT`,
  );
  const e = refusal(() => buildDelete(notes, q("select=id"), { representation: false }));
  assertEquals([e.code, e.message], ["21000", "DELETE requires a WHERE clause"]);
});

Deno.test("SQLSTATEs map to PostgREST's statuses", () => {
  const cases: Array<[string, number]> = [
    ["23505", 409],
    ["23503", 409],
    ["23502", 400],
    ["23514", 400],
    ["22P02", 400],
    ["42501", 403],
    ["42P01", 404],
    ["42883", 404],
    ["42703", 400],
    ["57014", 504],
    ["08006", 503],
    ["53300", 503],
    ["54000", 413],
    ["28P01", 403],
    ["0LP01", 403],
    ["25006", 405],
    ["P0001", 400],
    ["XX000", 500],
    ["40001", 500],
  ];
  for (const [code, status] of cases) assertEquals(statusForSqlState(code), status, code);
});

Deno.test("generated row types: Row, Insert (defaults optional, generated omitted), Update", () => {
  const source = generateRestTypes(new Map([["notes", notes]]), "public");
  assertStringIncludes(source, `declare module "@denext/backend/client"`);
  assertStringIncludes(source, `"id": number;`);
  assertStringIncludes(source, `"tags": string[] | null;`);
  assertStringIncludes(source, `"meta": Json | null;`);
  assertStringIncludes(source, `"mood": "ok" | "sad";`);
  assertStringIncludes(source, `"we\\"ird": string | null;`);
  const insert = source.slice(source.indexOf("Insert:"), source.indexOf("Update:"));
  assertStringIncludes(insert, `"id"?: number;`);
  assertStringIncludes(insert, `"body": string;`);
  assert(!insert.includes(`"size"`), "a generated column is not inserted");
  const update = source.slice(source.indexOf("Update:"));
  assertStringIncludes(update, `"body"?: string;`);
  assertStringIncludes(generateRestTypes(new Map(), "app"), "(no tables are exposed)");
  assertEquals(columnType(col("x", "x", { typeName: "money", category: "N" })), "string");
  assertEquals(columnType(col("x", "x", { typeName: "point", category: "G" })), "string");
  assertEquals(
    columnType(col("x", "x", { typeName: "rec", category: "C" })),
    "{ [key: string]: Json }",
  );
  assertEquals(columnType(col("x", "x", { typeName: "weird", category: "X" })), "unknown");
  assertEquals(
    columnType(col("x", "x", { category: "A", element: { typeName: "mood", category: "E" } })),
    "string[]",
  );
  assertEquals(
    columnType(col("x", "x", { category: "A", element: { typeName: "rec", category: "C" } })),
    "({ [key: string]: Json })[]",
  );
});
