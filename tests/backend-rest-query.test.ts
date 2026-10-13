// `@denext/backend` auto-REST: the request grammar and the statement builder, over a synthetic
// catalog. Every identifier passes the catalog whitelist and is quoted; every value is a `$n`
// parameter; embeds follow the catalog's foreign keys (many-to-one, one-to-many, one-to-one,
// many-to-many, hints, ambiguity); every operator, logic tree, cast and JSON path renders as
// expected; inserts, upserts, updates, deletes and function calls build the right statements;
// and the types `.denext/rest.ts` is generated with. Real Postgres runs these in
// tests/backend-rest-supabase-integration.test.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type {
  RestCatalog,
  RestColumn,
  RestForeignKey,
  RestFunction,
  RestTable,
} from "../packages/backend/src/rest-catalog.ts";
import {
  applyQuery,
  buildDelete,
  buildInsert,
  buildPlannedCount,
  buildRpc,
  buildRpcPlannedCount,
  buildSelect,
  buildUpdate,
  columnOf,
  countParam,
  functionSource,
  MAX_IN_VALUES,
  parseInList,
  type PlanNode,
  planOf,
  quoteIdent,
  resolveFunction,
  RestError,
  type RpcInput,
  tableSource,
} from "../packages/backend/src/rest-query.ts";
import {
  parseFilterValue,
  parseLogic,
  parseNameList,
  parseOrder,
  parseSelect,
  splitTopLevel,
} from "../packages/backend/src/rest-parse.ts";
import { resolveRelationship } from "../packages/backend/src/rest-relations.ts";
import { columnType, generateRestTypes } from "../packages/backend/src/rest-codegen.ts";
import { csvFromJson, rowsFromCsv } from "../packages/backend/src/rest-format.ts";
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

const int = (name: string, extra: Partial<RestColumn> = {}) =>
  col(name, "integer", { typeName: "int4", category: "N", ...extra });

function table(
  name: string,
  columns: RestColumn[],
  primaryKey: string[] = ["id"],
  uniqueKeys: string[][] = [primaryKey],
  schema = "public",
): RestTable {
  return { schema, name, kind: "table", columns, primaryKey, uniqueKeys };
}

const notes = table("notes", [
  int("id", { hasDefault: true }),
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
  int("size", { readOnly: true }),
  col('we"ird', "text", { nullable: true }),
  col("search", "tsvector", { typeName: "tsvector", category: "U", nullable: true }),
  col("during", "int4range", { typeName: "int4range", category: "R", nullable: true }),
]);
const authors = table("authors", [int("id"), col("name", "text")]);
const profiles = table("profiles", [int("id"), col("bio", "text")]);
const books = table("books", [int("id"), int("author_id"), col("title", "text"), int("count")]);
const editors = table("editors", [int("id"), col("name", "text")]);
const bookEditors = table("book_editors", [int("book_id"), int("editor_id")], [
  "book_id",
  "editor_id",
]);
const employees = table("employees", [int("id"), col("name", "text"), int("boss_id")]);
const messages = table("messages", [int("id"), int("from_id"), int("to_id")]);
const things = table("things", [int("id")], ["id"], [["id"]], "api");
const view: RestTable = { ...table("v", [int("id")], []), kind: "view" };

const fk = (
  name: string,
  from: RestTable,
  columns: string[],
  to: RestTable,
  foreignColumns: string[],
): RestForeignKey => ({
  name,
  table: { schema: from.schema, name: from.name },
  columns,
  foreignTable: { schema: to.schema, name: to.name },
  foreignColumns,
});

const intArg = {
  name: "a",
  castType: "integer",
  typeName: "int4",
  category: "N",
  hasDefault: false,
  variadic: false,
};
const add: RestFunction = {
  schema: "public",
  name: "add",
  args: [intArg, { ...intArg, name: "b", hasDefault: true }],
  volatility: "i",
  setOf: false,
  returns: { kind: "scalar", castType: "integer", column: int("") },
};
const addText: RestFunction = {
  ...add,
  args: [{ ...intArg, name: "x", castType: "text", typeName: "text", category: "S" }],
};
const booksBy: RestFunction = {
  schema: "public",
  name: "books_by",
  args: [{ ...intArg, name: "author" }],
  volatility: "s",
  setOf: true,
  returns: {
    kind: "composite",
    castType: "books",
    columns: books.columns,
    table: { schema: "public", name: "books" },
  },
};
const echo: RestFunction = {
  schema: "public",
  name: "echo",
  args: [{ ...intArg, name: "", castType: "json", typeName: "json", category: "U" }],
  volatility: "i",
  setOf: false,
  returns: { kind: "scalar", castType: "json", column: col("", "json", { typeName: "json" }) },
};
const touch: RestFunction = {
  schema: "public",
  name: "touch",
  args: [{ ...intArg, name: "ns", castType: "integer[]", variadic: true }],
  volatility: "v",
  setOf: false,
  returns: { kind: "void", castType: "void" },
};
const series: RestFunction = {
  schema: "public",
  name: "series",
  args: [],
  volatility: "i",
  setOf: true,
  returns: { kind: "scalar", castType: "integer", column: int("") },
};
const pair: RestFunction = {
  schema: "public",
  name: "pair",
  args: [],
  volatility: "s",
  setOf: false,
  returns: { kind: "composite", castType: "record", columns: [int("a"), col("b", "text")] },
};

const relations = [
  notes,
  authors,
  profiles,
  books,
  editors,
  bookEditors,
  employees,
  messages,
  view,
];
const catalog: RestCatalog = {
  schemas: ["public", "api"],
  tables: new Map([
    ["public", new Map(relations.map((t) => [t.name, t]))],
    ["api", new Map([["things", things]])],
  ]),
  foreignKeys: [
    fk("books_author_id_fkey", books, ["author_id"], authors, ["id"]),
    fk("profiles_id_fkey", profiles, ["id"], authors, ["id"]),
    fk("be_book", bookEditors, ["book_id"], books, ["id"]),
    fk("be_editor", bookEditors, ["editor_id"], editors, ["id"]),
    fk("employees_boss_id_fkey", employees, ["boss_id"], employees, ["id"]),
    fk("messages_from_fkey", messages, ["from_id"], authors, ["id"]),
    fk("messages_to_fkey", messages, ["to_id"], authors, ["id"]),
  ],
  functions: new Map([[
    "public",
    new Map([
      ["add", [add, addText]],
      ["books_by", [booksBy]],
      ["echo", [echo]],
      ["touch", [touch]],
      ["series", [series]],
      ["pair", [pair]],
    ]),
  ]]),
  enums: new Map([["public", new Map([["mood", ["ok", "sad"]]])]]),
  compositeTypes: [{ schema: "public", name: "point2", columns: [int("x", { nullable: true })] }],
  castTypes: new Map([
    ["text", "text"],
    ["integer", "integer"],
    ["mood", `"public"."mood"`],
    ["public.mood", `"public"."mood"`],
  ]),
  postgis: false,
};

const q = (s: string) => new URLSearchParams(s);
const page = { offset: 0, limit: 1000, count: false };

/** A plan for `query` over `t`, with the query applied. */
function plan(t: RestTable, query: string): PlanNode {
  const params = q(query);
  const p = planOf(catalog, tableSource(t), parseSelect(params.get("select")));
  applyQuery(p, params);
  return p;
}

/** The read statement for `query` over `t`. */
const select = (t: RestTable, query: string, options = page) =>
  buildSelect(plan(t, query), catalog, options);

/** The refusal `fn` throws. */
function refusal(fn: () => unknown): RestError {
  return assertThrows(fn, RestError) as RestError;
}

/** No representation. */
const none = { returning: { kind: "none" as const } };
/** A representation. */
const rows = { returning: { kind: "representation" as const } };

Deno.test("buildSelect: columns, filters as typed parameters, order, limit and offset", () => {
  const st = select(
    notes,
    "select=id,body&id=gte.5&body=like.a*b&done=is.false&order=id.desc.nullslast,body",
    { offset: 10, limit: 20, count: false },
  );
  assertEquals(
    st.text,
    `SELECT coalesce(json_agg(_r), '[]')::text AS body, count(*)::text AS n FROM (` +
      `SELECT t0."id" AS "id", t0."body" AS "body" FROM "public"."notes" AS t0 WHERE ` +
      `t0."id" >= $1::integer AND t0."body" LIKE $2::text AND t0."done" IS FALSE ` +
      `ORDER BY t0."id" DESC NULLS LAST, t0."body" ASC LIMIT 20 OFFSET 10) _r`,
  );
  assertEquals(st.params, ["5", "a%b"]);
});

Deno.test("buildSelect: * by default; count=exact counts with the same filters; planned", () => {
  const st = select(notes, "owner=eq.u1", { ...page, count: true });
  assertStringIncludes(
    st.text,
    `SELECT t0.* FROM "public"."notes" AS t0 WHERE t0."owner" = $1::uuid`,
  );
  assertStringIncludes(
    st.text,
    `(SELECT count(*) FROM (SELECT 1 FROM "public"."notes" AS t0 WHERE t0."owner" = $2::uuid) ` +
      `_c)::text AS total`,
  );
  assertEquals(st.params, ["u1", "u1"]);
  const planned = buildPlannedCount(plan(notes, "owner=eq.u1"), catalog);
  assertEquals(
    planned.text,
    `EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."notes" AS t0 WHERE t0."owner" = $1::uuid`,
  );
  const stripped = buildSelect(plan(notes, ""), catalog, { ...page, shape: "stripped" });
  assertStringIncludes(stripped.text, "json_strip_nulls(coalesce(json_agg(_r), '[]'))::text");
  const geo = buildSelect(plan(notes, ""), catalog, { ...page, shape: "geojson" });
  assertStringIncludes(geo.text, "ST_AsGeoJSON(_r)::json");
});

Deno.test("every operator, not., modifiers, in-lists with quotes, and array-typed columns", () => {
  const st = select(
    notes,
    'id=neq.1&id=gt.2&id=lt.9&id=lte.8&body=ilike.*x*&body=not.eq.y&id=in.(1,2)&body=in.("a,b","c\\"d")&tags=eq.{a,b}&meta=is.null&id=in.()',
  );
  assertStringIncludes(st.text, `t0."id" <> $1::integer AND t0."id" > $2::integer`);
  assertStringIncludes(st.text, `t0."id" < $3::integer AND t0."id" <= $4::integer`);
  assertStringIncludes(st.text, `t0."body" ILIKE $5::text AND NOT (t0."body" = $6::text)`);
  assertStringIncludes(st.text, `t0."id" IN ($7::integer, $8::integer)`);
  assertStringIncludes(st.text, `t0."body" IN ($9::text, $10::text)`);
  assertStringIncludes(st.text, `t0."tags" = $11::text[] AND t0."meta" IS NULL AND FALSE`);
  assertEquals(st.params, ["1", "2", "9", "8", "%x%", "y", "1", "2", "a,b", 'c"d', "{a,b}"]);
  const more = select(
    notes,
    "body=match.^a&body=imatch.b$&body=isdistinct.z&tags=cs.{a}&tags=cd.{a,b}&tags=ov.{c}" +
      "&during=sl.[1,2)&during=sr.[3,4)&during=nxl.[5,6)&during=nxr.[7,8)&during=adj.[9,10)" +
      "&id=eq(any).{1,2}&body=like(all).{a*,*b}&body=not.ilike(any).{x}&mood=eq.ok&meta=is.TRUE",
  );
  for (
    const part of [
      `t0."body" ~ $1::text`,
      `t0."body" ~* $2::text`,
      `t0."body" IS DISTINCT FROM $3::text`,
      `t0."tags" @> $4::text[]`,
      `t0."tags" <@ $5::text[]`,
      `t0."tags" && $6::text[]`,
      `t0."during" << $7::int4range`,
      `t0."during" >> $8::int4range`,
      `t0."during" &> $9::int4range`,
      `t0."during" &< $10::int4range`,
      `t0."during" -|- $11::int4range`,
      `t0."id" = ANY($12::integer[])`,
      `t0."body" LIKE ALL($13::text[])`,
      `NOT (t0."body" ILIKE ANY($14::text[]))`,
      `t0."mood" = $15::mood`,
      `t0."meta" IS TRUE`,
    ]
  ) assertStringIncludes(more.text, part);
  assertEquals(more.params[12], "{a%,%b}");
});

Deno.test("full-text search: on a tsvector, on text, with a configuration", () => {
  const st = select(
    notes,
    "search=fts.cat%26dog&body=plfts(english).fat+cats&search=phfts.a+b&body=wfts(simple).x",
  );
  assertStringIncludes(st.text, `t0."search" @@ to_tsquery($1::text)`);
  assertStringIncludes(
    st.text,
    `to_tsvector($2::regconfig, t0."body") @@ plainto_tsquery($2::regconfig, $3::text)`,
  );
  assertStringIncludes(st.text, `t0."search" @@ phraseto_tsquery($4::text)`);
  assertStringIncludes(st.text, `websearch_to_tsquery($5::regconfig, $6::text)`);
  assertEquals(st.params, ["cat&dog", "english", "fat cats", "a b", "simple", "x"]);
  refusal(() => select(notes, "id=eq(english).1"));
  refusal(() => select(notes, "tags=cs(any).{a}"));
});

Deno.test("logic trees: or / and, nested, negated, quoted values, on an embed", () => {
  const st = select(
    notes,
    'or=(id.eq.1,and(body.like.a*,done.is.true),not.or(id.gt.5,body.eq."x,y"))&not.and=(id.lt.0,id.gt.100)',
  );
  assertStringIncludes(
    st.text,
    `(t0."id" = $1::integer OR (t0."body" LIKE $2::text AND t0."done" IS TRUE) OR ` +
      `NOT (t0."id" > $3::integer OR t0."body" = $4::text))`,
  );
  assertStringIncludes(st.text, `NOT (t0."id" < $5::integer AND t0."id" > $6::integer)`);
  assertEquals(st.params, ["1", "a%", "5", "x,y", "0", "100"]);
  const inList = select(notes, 'or=(id.in.(1,2),body.in.("a,b",c))');
  assertStringIncludes(inList.text, `t0."id" IN ($1::integer, $2::integer) OR t0."body" IN`);
  assertEquals(inList.params.slice(2), ["a,b", "c"]);
  const embedded = select(authors, "select=name,books(title)&books.or=(title.eq.a,id.eq.2)");
  assertStringIncludes(embedded.text, `(t1."title" = $1::text OR t1."id" = $2::integer)`);
  for (const bad of ["or=id.eq.1", "or=()", "or=(id)", "or=(id.eq.1", "and=(nope.eq.1)"]) {
    refusal(() => select(notes, bad));
  }
  let deep = "id.eq.1";
  for (let i = 0; i < 10; i++) deep = `and(${deep})`;
  refusal(() => select(notes, `or=(${deep})`));
});

Deno.test("aliases, casts and JSON paths in select, filter and order", () => {
  const st = select(
    notes,
    "select=label:body,meta->a->>b,first:tags::text,meta->list->0,mood::public.mood" +
      '&meta->>k=eq.v&meta->obj=cs.{"x":1}&order=meta->>k.desc,body',
  );
  assertStringIncludes(st.text, `t0."body" AS "label"`);
  // The WHERE is rendered first, then the select list, then the order.
  assertStringIncludes(st.text, `(t0."meta"->>$1::text) = $2::text`);
  assertStringIncludes(st.text, `(t0."meta"->$3::text)::jsonb @> $4::jsonb`);
  assertStringIncludes(st.text, `(t0."meta"->$5::text->>$6::text) AS "b"`);
  assertStringIncludes(st.text, `(t0."tags")::text AS "first"`);
  assertStringIncludes(st.text, `(t0."meta"->$7::text->$8::integer)::jsonb AS "meta"`);
  assertStringIncludes(st.text, `(t0."mood")::"public"."mood" AS "mood"`);
  assertStringIncludes(st.text, `ORDER BY (t0."meta"->>$9::text) DESC, t0."body" ASC`);
  assertEquals(st.params, ["k", "v", "obj", '{"x":1}', "a", "b", "list", "0", "k"]);
  assertEquals(refusal(() => select(notes, "select=id::nosuch")).code, "42704");
  assertStringIncludes(select(notes, "select=id::text[]").text, `(t0."id")::text[]`);
  refusal(() => select(notes, "select=id::text;drop"));
  refusal(() => select(notes, "select=id.sum()"));
  refusal(() => select(notes, "select=meta->"));
});

Deno.test("embeds: many-to-one, one-to-many, one-to-one, many-to-many, nested", () => {
  const m2o = select(books, "select=title,author:authors(name)");
  assertStringIncludes(
    m2o.text,
    `LEFT JOIN LATERAL (SELECT row_to_json(_e) AS v FROM (SELECT t1."name" AS "name" FROM ` +
      `"public"."authors" AS t1 WHERE t1."id" = t0."author_id") _e) AS l2 ON TRUE`,
  );
  assertStringIncludes(m2o.text, `l2.v AS "author"`);
  const o2m = select(
    authors,
    "select=name,books(title)&books.order=title&books.limit=2&books.offset=1",
  );
  assertStringIncludes(o2m.text, `coalesce(l2.v, '[]'::json) AS "books"`);
  assertStringIncludes(
    o2m.text,
    `SELECT json_agg(_e) AS v FROM (SELECT t1."title" AS "title" FROM "public"."books" AS t1 ` +
      `WHERE t1."author_id" = t0."id" ORDER BY t1."title" ASC LIMIT 2 OFFSET 1) _e`,
  );
  assertStringIncludes(select(authors, "select=profiles(bio)").text, "row_to_json(_e)");
  const m2m = select(books, "select=editors(name)");
  assertStringIncludes(
    m2m.text,
    `FROM "public"."editors" AS t1 JOIN "public"."book_editors" AS j3 ON j3."editor_id" = ` +
      `t1."id" WHERE j3."book_id" = t0."id"`,
  );
  const nested = select(editors, "select=books(title,authors(name))&books.authors.name=eq.x");
  assertStringIncludes(nested.text, `."name" = $1::text`);
  const rel = resolveRelationship(catalog, editors, "books", undefined);
  assertEquals([rel.kind, rel.toOne, rel.name], ["m2m", false, "book_editors"]);
});

Deno.test("embeds: !inner, null filters, spread, count, hints, ambiguity, self-reference", () => {
  const inner = select(authors, "select=books!inner(id)&books.title=eq.x");
  assertStringIncludes(inner.text, `WHERE l2.v IS NOT NULL`);
  const total = select(authors, "select=books!inner(id),profiles(bio)", { ...page, count: true });
  assertStringIncludes(total.text, "count(*) FROM (SELECT 1 FROM");
  assertStringIncludes(select(authors, "select=books(id)&books=not.is.null").text, `IS NOT NULL`);
  assertStringIncludes(select(authors, "select=books(id)&books=is.null").text, `l2.v IS NULL`);
  refusal(() => select(authors, "select=books(id)&books=eq.1"));
  const spread = select(books, "select=title,...authors(author:name)");
  assertStringIncludes(spread.text, `l2.*`);
  assertStringIncludes(spread.text, `LEFT JOIN LATERAL (SELECT t1."name" AS "author" FROM`);
  assertStringIncludes(select(books, "select=...authors!inner(name)").text, " JOIN LATERAL (");
  assertEquals(refusal(() => select(authors, "select=...books(id)")).code, "PGRST119");
  // `count` is the shorthand unless the target has a column of that name (books does).
  const count = select(editors, "select=books(count)");
  assertStringIncludes(count.text, `t1."count" AS "count"`);
  assertStringIncludes(
    select(books, "select=editors(count)").text,
    "json_build_array(json_build_object('count', count(*)))",
  );
  const toOne = select(books, "select=authors(count)").text;
  assertStringIncludes(toOne, "SELECT json_build_object('count', count(*)) AS v");
  const ambiguous = refusal(() => select(authors, "select=messages(id)"));
  assertEquals([ambiguous.status, ambiguous.code], [300, "PGRST201"]);
  assert(Array.isArray(ambiguous.details) && ambiguous.details.length === 2);
  assertStringIncludes(
    select(authors, "select=messages!messages_to_fkey(id)").text,
    `t1."to_id" = t0."id"`,
  );
  assertStringIncludes(
    select(messages, "select=authors!from_id(name)").text,
    `t1."id" = t0."from_id"`,
  );
  assertStringIncludes(select(messages, "select=to_id(name)").text, `t1."id" = t0."to_id"`);
  assertStringIncludes(select(books, "select=editors!book_editors(name)").text, "j3");
  assertStringIncludes(select(books, "select=editors!be_editor(name)").text, "j3");
  const missing = refusal(() => select(authors, "select=editors(name)"));
  assertEquals([missing.status, missing.code], [400, "PGRST200"]);
  const reports = select(employees, "select=reports:employees!boss_id(name)");
  assertStringIncludes(reports.text, `t1."boss_id" = t0."id"`);
  assertStringIncludes(
    select(employees, "select=boss:boss_id(name)").text,
    `t1."id" = t0."boss_id"`,
  );
  const deep = "books(authors(".repeat(5) + "id" + "))".repeat(5);
  refusal(() => select(authors, `select=${deep}`));
  refusal(() => planOf(catalog, functionSource(pair), parseSelect("x(id)")));
});

Deno.test("injection through a value stays a parameter", () => {
  const evil = "1; drop table notes; --";
  const st = select(notes, `body=eq.${encodeURIComponent(evil)}&body=in.(x'),'y)`);
  assert(!st.text.includes("drop table"));
  assert(!st.text.includes("x'"));
  assertEquals(st.params, [evil, "x')", "'y"]);
});

Deno.test("injection through a name: unknown columns, relations and casts are refused", () => {
  for (const attack of [`body"; drop table notes; --`, "body) or (1=1", "Body", "notes.body"]) {
    const e = refusal(() => select(notes, `${encodeURIComponent(attack)}=eq.1`));
    assertEquals(e.status, 400, attack);
    refusal(() => select(notes, `select=${encodeURIComponent(attack)}`));
    refusal(() => select(notes, `order=${encodeURIComponent(attack)}`));
  }
  assertEquals(refusal(() => select(notes, "nope=eq.1")).code, "42703");
  assertEquals(quoteIdent('we"ird'), '"we""ird"');
  assertStringIncludes(select(notes, 'select="we""ird"').text, `t0."we""ird"`);
  assertStringIncludes(select(notes, 'select=x:"we""ird"').text, `AS "x"`);
});

Deno.test("refusals: operators, is values, modifiers, malformed lists", () => {
  const cases = [
    "id=1",
    "id=regex.x",
    "id=is.maybe",
    "id=in.1,2",
    'id=in.("a',
    'id=in.("a"b)',
    "order=id.sideways",
    "order=id.asc.desc",
    "select=id,,body",
    "select=books(id",
    "select=books!(id)",
    "select=...name",
  ];
  for (const query of cases) assertEquals(refusal(() => select(notes, query)).status, 400, query);
  const many = Array.from({ length: 65 }, (_, i) => `id=eq.${i}`).join("&");
  refusal(() => select(notes, many));
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
  assertEquals(parseNameList('"a b",c', "columns"), ["a b", "c"]);
  refusal(() => parseNameList("a,(b)", "columns"));
  assertEquals(splitTopLevel('a,"b,c",d(e,f)'), ["a", '"b,c"', "d(e,f)"]);
  refusal(() => splitTopLevel("a)"));
  refusal(() => splitTopLevel('a"'));
  assertEquals(parseOrder(""), []);
  assertEquals(parseFilterValue("not.fts(english).x", "c").modifier, "english");
  refusal(() => parseLogic("or", false, "x".repeat(20_000), { filters: 0 }));
  refusal(() => parseSelect("x".repeat(20_000)));
  refusal(() => parseSelect(Array.from({ length: 300 }, () => "id").join(",")));
  assertEquals(parseSelect("  "), [{ kind: "star" }]);
});

Deno.test("buildInsert: one json parameter over the row type; representation embeds", () => {
  const one = buildInsert(notes, plan(notes, ""), catalog, { owner: "u1", body: "hi" }, none);
  assertEquals(
    one.text,
    `INSERT INTO "public"."notes" AS t0 ("owner", "body") SELECT "owner", "body" FROM ` +
      `json_populate_recordset(NULL::"public"."notes", $1::json)`,
  );
  assertEquals(one.params, [JSON.stringify([{ owner: "u1", body: "hi" }])]);
  const many = buildInsert(
    books,
    plan(books, "select=id,authors(name)"),
    catalog,
    [{ title: "a" }, { title: "b" }],
    rows,
  );
  assertStringIncludes(many.text, `RETURNING t0."id", t0."author_id") SELECT`);
  assertStringIncludes(many.text, `FROM _m AS t0 LEFT JOIN LATERAL`);
  const counted = buildInsert(notes, plan(notes, ""), catalog, {}, {
    returning: { kind: "count" },
  });
  assertEquals(
    counted.text,
    `WITH _m AS (INSERT INTO "public"."notes" AS t0 DEFAULT VALUES RETURNING 1) ` +
      `SELECT count(*)::text AS n FROM _m`,
  );
  assertStringIncludes(
    buildInsert(notes, plan(notes, ""), catalog, { body: "x" }, rows).text,
    "RETURNING t0.*",
  );
  assertStringIncludes(
    buildInsert(authors, plan(authors, "select=books(id)"), catalog, { name: "x" }, rows).text,
    `RETURNING t0."id"`,
  );
  const blank: PlanNode = { ...plan(authors, ""), items: [] };
  assertStringIncludes(
    buildInsert(authors, blank, catalog, { name: "x" }, rows).text,
    `RETURNING 1 AS "?"`,
  );
});

Deno.test("buildInsert: columns=, missing=default, upserts", () => {
  const columns = buildInsert(
    notes,
    plan(notes, ""),
    catalog,
    [{ body: "a" }, { body: "b", owner: "u" }],
    { columns: ["body", "owner"], ...none },
  );
  assertStringIncludes(columns.text, `("body", "owner")`);
  const defaults = buildInsert(
    notes,
    plan(notes, ""),
    catalog,
    [{ body: "a" }, { body: "b", done: true }],
    { columns: ["body", "done"], missingDefault: true, ...none },
  );
  const cell = (c: string, n: number) =>
    `(SELECT _p."${c}" FROM json_populate_record(NULL::"public"."notes", $${n}::json) _p)`;
  assertStringIncludes(
    defaults.text,
    `VALUES (${cell("body", 1)}, DEFAULT), (${cell("body", 2)}, ${cell("done", 2)})`,
  );
  const upsert = (body: unknown, conflict: object, t = notes) =>
    buildInsert(t, plan(t, ""), catalog, body, {
      conflict: conflict as { action: "merge" },
      ...none,
    }).text;
  assertStringIncludes(
    upsert({ id: 1, body: "x" }, { action: "merge" }),
    `ON CONFLICT ("id") DO UPDATE SET "body" = EXCLUDED."body"`,
  );
  assertStringIncludes(upsert({ id: 1 }, { action: "merge" }), `ON CONFLICT ("id") DO NOTHING`);
  assertStringIncludes(
    upsert({ body: "x" }, { action: "ignore", columns: ["body"] }),
    `ON CONFLICT ("body") DO NOTHING`,
  );
  assertStringIncludes(upsert({ id: 1 }, { action: "ignore" }, view), "ON CONFLICT DO NOTHING");
  refusal(() => upsert({ id: 1 }, { action: "merge" }, view));
  refusal(() => upsert({ id: 1 }, { action: "merge", columns: ["nope"] }));
  refusal(() =>
    buildInsert(
      notes,
      plan(notes, ""),
      catalog,
      Array.from({ length: 10_001 }, () => ({ body: "x" })),
      { missingDefault: true, ...none },
    )
  );
});

Deno.test("buildInsert refusals: shapes, mismatched keys, unknown and generated columns", () => {
  const insert = (body: unknown) => buildInsert(notes, plan(notes, ""), catalog, body, none);
  const bad: unknown[] = [null, 1, "x", [], [1], [{ body: "a" }, { owner: "b" }], [{}, {}]];
  for (const body of bad) {
    const e = refusal(() => insert(body));
    assertEquals([e.status, e.code], [400, "PGRST102"], JSON.stringify(body));
  }
  assertEquals(refusal(() => insert({ nope: 1 })).code, "42703");
  assertEquals(refusal(() => insert({ size: 1 })).code, "428C9");
  assertEquals(refusal(() => insert({ 'body") values (1); --': "x" })).code, "42703");
});

Deno.test("buildUpdate: SET from one json parameter, filters after it; no filter is refused", () => {
  const st = buildUpdate(
    notes,
    plan(notes, "id=eq.3&select=id,body"),
    catalog,
    { body: "new" },
    rows,
  );
  assertEquals(
    st.text,
    `WITH _m AS (UPDATE "public"."notes" AS t0 SET ("body") = (SELECT "body" FROM ` +
      `json_populate_record(NULL::"public"."notes", $1::json)) WHERE t0."id" = $2::integer ` +
      `RETURNING t0."id", t0."body") SELECT coalesce(json_agg(_r), '[]')::text AS body, ` +
      `count(*)::text AS n FROM (SELECT t0."id" AS "id", t0."body" AS "body" FROM _m AS t0) _r`,
  );
  assertEquals(st.params, ['{"body":"new"}', "3"]);
  const update = (query: string, body: unknown, columns?: string[]) =>
    buildUpdate(notes, plan(notes, query), catalog, body, {
      ...none,
      ...(columns ? { columns } : {}),
    });
  const unfiltered = refusal(() => update("", { body: "x" }));
  assertEquals([unfiltered.status, unfiltered.code, unfiltered.message], [
    400,
    "21000",
    "UPDATE requires a WHERE clause",
  ]);
  refusal(() => update("select=id&order=id", { body: "x" }));
  refusal(() => update("id=eq.1", [{ body: "x" }]));
  refusal(() => update("id=eq.1", {}));
  assertEquals(refusal(() => update("id=eq.1", { size: 2 })).code, "428C9");
  assertStringIncludes(update("id=eq.1", { body: "x", owner: "y" }, ["body"]).text, `("body")`);
});

Deno.test("buildDelete: filters required; representation returns the deleted rows", () => {
  assertEquals(buildDelete(notes, plan(notes, "owner=eq.u1"), catalog, none), {
    text: `DELETE FROM "public"."notes" AS t0 WHERE t0."owner" = $1::uuid`,
    params: ["u1"],
  });
  assertStringIncludes(
    buildDelete(notes, plan(notes, "id=in.(1,2)"), catalog, rows).text,
    `RETURNING t0.*) SELECT`,
  );
  const e = refusal(() => buildDelete(notes, plan(notes, "select=id"), catalog, none));
  assertEquals([e.code, e.message], ["21000", "DELETE requires a WHERE clause"]);
});

Deno.test("functions: overloads by argument names, a single json argument", () => {
  const body = (b: unknown): RpcInput => ({ kind: "body", body: b });
  const query = (s: string): RpcInput => ({ kind: "query", query: q(s) });
  const call = (name: string, input: RpcInput, single = false) =>
    resolveFunction(catalog, "public", name, input, single);
  assertEquals(call("add", body({ a: 1 })).fn, add);
  assertEquals(call("add", body({ x: "s" })).fn, addText);
  assertEquals(call("add", query("a=1&b=2&id=eq.3")).fn, add);
  assertEquals(call("echo", body([1, 2])).whole, true);
  assertEquals(call("echo", body({ k: 1 }), true).whole, true);
  assertEquals(refusal(() => call("add", body({ z: 1 }))).code, "PGRST202");
  assertEquals(refusal(() => call("nope", body({}))).status, 404);
  const twin = { ...add, args: [{ ...intArg, hasDefault: true }] };
  const ambiguous: RestCatalog = {
    ...catalog,
    functions: new Map([["public", new Map([["add", [add, twin]]])]]),
  };
  const resolve = (input: RpcInput) => resolveFunction(ambiguous, "public", "add", input, false);
  assertEquals(refusal(() => resolve(body({ a: 1 }))).code, "PGRST203");
  assertEquals(resolve(query("a=1&b=2")).fn, add);
  assertEquals(refusal(() => resolve(query("a=1"))).code, "PGRST203");
});

Deno.test("functions: every result kind, arguments from a body or the query, counts", () => {
  const body = (b: unknown): RpcInput => ({ kind: "body", body: b });
  const query = (s: string): RpcInput => ({ kind: "query", query: q(s) });
  const rpc = (fn: RestFunction, input: RpcInput, extra = "", whole = false, count = false) => {
    const params = q(extra);
    const items = fn.returns.kind === "composite" ? parseSelect(params.get("select")) : [];
    const p = planOf(catalog, functionSource(fn), items);
    const skip = input.kind === "query" ? new Set(fn.args.map((a) => a.name)) : new Set<string>();
    applyQuery(p, params, skip);
    return buildRpc(p, catalog, { fn, whole, input, offset: 0, limit: 10, count });
  };
  const arg = (name: string) =>
    `"${name}" => (SELECT _a."${name}" FROM json_to_record($1::json) AS _a("${name}" integer))`;
  assertEquals(
    rpc(add, body({ a: 1, b: 2 })).text,
    `SELECT to_json("public"."add"(${arg("a")}, ${arg("b")}))::text AS body, '1' AS n`,
  );
  assertStringIncludes(rpc(add, query("a=1")).text, `"public"."add"("a" => $1::integer)`);
  assertStringIncludes(rpc(echo, body([1]), "", true).text, `"public"."echo"($1::json)`);
  assertStringIncludes(rpc(series, body({})).text, `"public"."series"()`);
  assertStringIncludes(
    rpc(touch, body({ ns: [1] })).text,
    `SELECT count(*)::text AS n FROM (SELECT "public"."touch"(VARIADIC "ns" =>`,
  );
  assertStringIncludes(rpc(touch, query("ns={1}")).text, `VARIADIC "ns" => $1::integer[]`);
  const set = rpc(
    booksBy,
    body({ author: 1 }),
    "select=title,authors(name)&title=like.a*",
    false,
    true,
  );
  assertStringIncludes(set.text, `WITH _f AS MATERIALIZED (SELECT * FROM "public"."books_by"(`);
  assertStringIncludes(set.text, `FROM _f AS t0 LEFT JOIN LATERAL`);
  assertStringIncludes(set.text, `t0."title" LIKE`);
  assertStringIncludes(set.text, "AS total");
  const scalars = rpc(series, query(""), "", false, true);
  assertStringIncludes(scalars.text, `SELECT _x AS v FROM "public"."series"() AS _x`);
  assertStringIncludes(scalars.text, "(SELECT count(*) FROM _f)::text AS total");
  assertStringIncludes(rpc(pair, body({})).text, `SELECT * FROM "public"."pair"() AS _x`);
  const planned = buildRpcPlannedCount(planOf(catalog, functionSource(booksBy), []), catalog, {
    fn: booksBy,
    whole: false,
    input: body({ author: 1 }),
  });
  assertStringIncludes(planned.text, "EXPLAIN (FORMAT JSON) SELECT 1 FROM (SELECT * FROM");
  const plannedScalar = buildRpcPlannedCount(planOf(catalog, functionSource(series), []), catalog, {
    fn: series,
    whole: false,
    input: query(""),
  });
  assertStringIncludes(plannedScalar.text, "SELECT 1 FROM (SELECT _x AS v FROM");
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

Deno.test("generated types: supabase gen types shape, relationships, functions, enums", () => {
  const source = generateRestTypes(catalog);
  for (
    const part of [
      `declare module "@denext/backend/client"`,
      `export type Database = {`,
      `PostgrestVersion: "12";`,
      `id: number;`,
      `tags: string[] | null;`,
      `meta: Json | null;`,
      `mood: "ok" | "sad";`,
      `"we\\"ird": string | null;`,
      `foreignKeyName: "books_author_id_fkey";`,
      `referencedRelation: "authors";`,
      `isOneToOne: true;`,
      `Args: Record<PropertyKey, never>;`,
      `b?: number;`,
      `Returns: undefined;`,
      `Returns: number[];`,
      `"": Json;`,
      `| {`,
      `mood: ["ok", "sad"],`,
      `point2: {`,
      `Views: {\n      v: {`,
      `api: {`,
      `[_ in never]: never;`,
    ]
  ) assertStringIncludes(source, part);
  const insert = source.slice(source.indexOf("Insert:", source.indexOf("notes: {")));
  assertStringIncludes(insert, `id?: number;`);
  assert(!insert.slice(0, insert.indexOf("Update:")).includes("size"), "generated: not inserted");
  assertEquals(columnType(col("x", "x", { typeName: "money", category: "N" })), "string");
  assertEquals(columnType(col("x", "x", { typeName: "point", category: "G" })), "string");
  assertEquals(columnType(col("x", "x", { typeName: "rec", category: "C" })), "Json");
  assertEquals(columnType(col("x", "x", { typeName: "weird", category: "X" })), "unknown");
  assertEquals(columnType(col("x", "x", { typeName: "e", category: "E" })), "string");
  assertEquals(
    columnType(col("x", "x", { category: "A", element: { typeName: "mood", category: "E" } })),
    "string[]",
  );
  assertEquals(
    columnType(col("x", "x", { category: "A", element: { typeName: "a", category: "B" } })),
    "boolean[]",
  );
});

Deno.test("CSV: rows out with exact numbers and quoting; bodies in with NULL", () => {
  assertEquals(
    csvFromJson(
      '[{"id":9007199254740993,"name":"a, b","j":{"x":[1]},"n":null,"t":true,"q":"say \\"hi\\""}]',
    ),
    'id,name,j,n,t,q\n9007199254740993,"a, b","{""x"":[1]}",,true,"say ""hi"""\n',
  );
  assertEquals(csvFromJson("[]"), "");
  assertEquals(csvFromJson("[1,2]"), "1\n2\n");
  assertEquals(rowsFromCsv('id,name\r\n1,"x, ""y"""\n2,NULL\n3,"NULL"\n\n'), [
    { id: "1", name: 'x, "y"' },
    { id: "2", name: null },
    { id: "3", name: "NULL" },
  ]);
  assertEquals(rowsFromCsv("a\n"), []);
  assertThrows(() => rowsFromCsv(""), RestError);
  assertThrows(() => rowsFromCsv('a\n"x'), RestError);
  assertThrows(() => rowsFromCsv("a,b\n1"), RestError);
});
