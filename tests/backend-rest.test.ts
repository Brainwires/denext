// `@denext/backend` auto-REST through a real denext request pipeline (createApp + the plugin
// seam + denextAuth), on the fake SQL client: the REST statements and the catalog reads are
// answered by a scripted responder, while the RLS setup and the `statement_timeout` run on the
// fake as they would on Postgres — so each test sees the role, claims and timeout a statement
// ran under, the status, headers and body the handler answered, the CSRF rule for cookie
// writes, the error envelope, the catalog cache, the generated `.denext/rest.ts`, and the
// browser client driving the handler. Real policies are in tests/backend-rest-integration.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runPluginPrepareSteps,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import type { SqlQuery, SqlRow } from "../src/server/postgres.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { backend, type RestOptions } from "../packages/backend/mod.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { readRestCatalog, type RestCatalog } from "../packages/backend/src/rest-catalog.ts";
import {
  concurrencyOf,
  resolveRest,
  RestCatalogCache,
  skippedWarning,
  StatementGate,
} from "../packages/backend/src/rest.ts";
import { RestError } from "../packages/backend/src/rest-query.ts";
import { writeRestTypes } from "../packages/backend/src/rest-codegen.ts";
import { restClient, RestClientError, type Selected } from "../packages/backend/client.ts";
import { type FakeSqlClient, fakeSqlClient } from "./helpers/fake-sql-client.ts";
import {
  generateSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
} from "../src/server/auth/gotrue/keys.ts";

const ORIGIN = "https://app.test";
/** An empty app for every test (removed when the module unloads). */
const ROOT = Deno.makeTempDirSync({ prefix: "dnx-rest-app-" });
Deno.mkdirSync(`${ROOT}/app`);
globalThis.addEventListener("unload", () => Deno.removeSync(ROOT, { recursive: true }));
const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const authConfig: AuthConfig = {
  secret: "rest-secret-at-least-32-characters-long!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** The catalog the fake answers: `notes (id, owner, body, size generated)` in `public`. */
const COLUMN_ROWS: SqlRow[] = [
  ["id", "integer", "int4", "N", "false", "true", "false"],
  ["owner", "uuid", "uuid", "U", "false", "false", "false"],
  ["body", "text", "text", "S", "true", "false", "false"],
  ["size", "integer", "int4", "N", "true", "false", "true"],
].map(([name, cast, type, category, nullable, hasDefault, readOnly]) => ({
  schema: "public",
  table: "notes",
  kind: "r",
  rls: "true",
  name,
  cast_type: cast,
  type_name: type,
  category,
  element_name: null,
  element_category: null,
  enum_labels: null,
  nullable,
  has_default: hasDefault,
  read_only: readOnly,
}));
const KEY_ROWS: SqlRow[] = [
  { schema: "public", table: "notes", primary: "true", columns: '["id"]' },
];

/** The functions the fake's catalog lists (none unless a test sets them). */
let FUNCTION_ROWS: SqlRow[] = [];
/** The types the fake's catalog lists. */
let TYPE_ROWS: SqlRow[] = [];
/** The row-type attributes the fake's catalog lists. */
let ATTRIBUTE_ROWS: SqlRow[] = [];

/** The fake's answer to one of the catalog's queries, or `undefined` for anything else. */
function catalogAnswer(text: string, columns: () => SqlRow[]): SqlRow[] | undefined {
  if (text.includes("JOIN pg_attribute a ON a.attrelid = c.oid")) return columns();
  if (text.includes("FROM pg_index")) return KEY_ROWS;
  if (text.includes("FROM pg_constraint")) return [];
  if (text.includes("FROM pg_type t")) return TYPE_ROWS;
  if (text.includes("FROM pg_attribute a")) return ATTRIBUTE_ROWS;
  if (text.includes("FROM pg_proc")) return FUNCTION_ROWS;
  if (text.includes("pg_extension")) return [{ postgis: "false" }];
  return undefined;
}

/** One REST statement as it reached the database. */
interface Seen {
  text: string;
  params: unknown[];
  role: string | undefined;
  claims: Record<string, unknown>;
  timeout: string | undefined;
}

type Responder = (seen: Seen) => SqlRow[];

interface RestApp {
  sql: FakeSqlClient;
  seen: Seen[];
  call(
    path: string,
    init?: RequestInit & { cookie?: string; crossSite?: boolean },
  ): Promise<Response>;
  fetch: typeof fetch;
}

/**
 * Build an app with `backend({ postgres, rest })` whose catalog and REST statements `respond`
 * answers (by default: one page holding `[{"id":1}]`).
 */
async function restApp(
  respond: Responder = () => [{ body: '[{"id":1}]', n: "1" }],
  rest: RestOptions = {},
  catalog: () => SqlRow[] = () => COLUMN_ROWS,
): Promise<RestApp> {
  const sql = fakeSqlClient();
  const seen: Seen[] = [];
  const unsafe = sql.unsafe.bind(sql);
  const answer = (text: string, params: unknown[] = []): SqlRow[] => {
    const rows = catalogAnswer(text, catalog);
    if (rows) return rows;
    const entry: Seen = {
      text,
      params,
      role: sql.settings.get("role"),
      claims: JSON.parse(sql.settings.get("request.jwt.claims") ?? "{}"),
      timeout: sql.settings.get("statement_timeout"),
    };
    seen.push(entry);
    return respond(entry);
  };
  sql.unsafe = (<T>(text: string, params?: unknown[]): SqlQuery<T> => {
    if (!/pg_[a-z]+|^SELECT|^WITH|^INSERT|^UPDATE|^DELETE|^EXPLAIN/.test(text)) {
      return unsafe<T>(text, params);
    }
    return {
      then: (ok, fail) => Promise.resolve().then(() => answer(text, params) as T[]).then(ok, fail),
    };
  }) as FakeSqlClient["unsafe"];
  resetPlugins();
  installPostgres(undefined);
  const root = ROOT;
  const config = {
    plugins: [
      denextAuth(authConfig),
      backend({ postgres: { sql, rls: { migrate: false } }, rest }),
    ],
  } as DenextConfig;
  await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
  const manifest = await scanRoutes(`${root}/app`);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    matchExternal: getPluginRequestHandler(),
  });
  const call: RestApp["call"] = (path, init = {}) => {
    const { cookie, crossSite, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("host", "app.test");
    if (cookie) headers.set("cookie", cookie);
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const method = rest.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) {
      headers.set("origin", crossSite ? "https://evil.test" : ORIGIN);
    }
    return handler(new Request(new URL(path, ORIGIN), { ...rest, headers }));
  };
  const fetchVia = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return call(url.pathname + url.search, init);
  }) as typeof fetch;
  return { sql, seen, call, fetch: fetchVia };
}

function tearDown(): void {
  resetPlugins();
  installPostgres(undefined);
  FUNCTION_ROWS = [];
  TYPE_ROWS = [];
  ATTRIBUTE_ROWS = [];
}

/** A signed-in user's session cookie. */
async function cookieFor(id: string): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/** Silence `console.error` / `console.warn` around `fn`, returning what was logged. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const { error, warn } = console;
  console.error = console.warn = (...args: unknown[]) => void logged.push(args);
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

Deno.test("GET reads as anon under a statement timeout, answering Postgres's JSON as is", async () => {
  const app = await restApp();
  try {
    const res = await app.call("/rest/v1/notes?select=id,body&id=gt.0&order=id.desc&limit=5");
    assertEquals(res.status, 200);
    assertEquals(await res.text(), '[{"id":1}]');
    assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
    assertEquals(res.headers.get("content-range"), "0-0/*");
    assertEquals(res.headers.get("cache-control"), "private, no-store");
    const [run] = app.seen;
    assertEquals([run.role, run.claims.role, run.timeout], ["anon", "anon", "5000"]);
    assertStringIncludes(
      run.text,
      `SELECT t0."id" AS "id", t0."body" AS "body" FROM "public"."notes" AS t0 WHERE ` +
        `t0."id" > $1::integer`,
    );
    assertStringIncludes(run.text, `ORDER BY t0."id" DESC LIMIT 5`);
    assertEquals(run.params, ["0"]);
    // BEGIN, the RLS setup, the timeout and the query, then COMMIT: one transaction.
    const tail = app.sql.statements.slice(-4);
    assertEquals(tail[0], "BEGIN");
    assertStringIncludes(tail[2], "statement_timeout");
    assertStringIncludes(tail[2], "transaction_read_only", "a read is READ ONLY");
    assertEquals(tail[3], "COMMIT");
  } finally {
    tearDown();
  }
});

Deno.test("a signed-in request runs as authenticated with the user's claims", async () => {
  const app = await restApp();
  try {
    const res = await app.call("/rest/v1/notes", { cookie: await cookieFor("user-a") });
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(app.seen[0].role, "authenticated");
    assertEquals(app.seen[0].claims.sub, "user-a");
  } finally {
    tearDown();
  }
});

Deno.test("Range, count=exact, maxRows and HEAD", async () => {
  const app = await restApp(
    () => [{ body: '[{"id":3},{"id":4}]', n: "2", total: "5" }],
    { maxRows: 3, statementTimeout: 250, exactCount: "all" },
  );
  try {
    const res = await app.call("/rest/v1/notes?limit=50", {
      headers: { range: "2-9", prefer: "count=exact, return=representation" },
    });
    assertEquals(res.status, 206);
    assertEquals(res.headers.get("content-range"), "2-3/5");
    assertEquals(res.headers.get("preference-applied"), "count=exact");
    await res.body?.cancel();
    assertStringIncludes(app.seen[0].text, "LIMIT 3 OFFSET 2");
    assertStringIncludes(app.seen[0].text, "AS total");
    assertEquals(app.seen[0].timeout, "250");
    const head = await app.call("/rest/v1/notes?offset=1", { method: "HEAD" });
    assertEquals([head.status, await head.text()], [200, ""]);
    assertStringIncludes(app.seen[1].text, "LIMIT 3 OFFSET 1");
  } finally {
    tearDown();
  }
});

Deno.test("an offset past every row is 416; a reversed Range is 416", async () => {
  const app = await restApp(() => [{ body: "[]", n: "0", total: "4" }], { exactCount: "all" });
  try {
    const past = await app.call("/rest/v1/notes?offset=10", { headers: { prefer: "count=exact" } });
    assertEquals(past.status, 416);
    assertEquals((await past.json()).code, "PGRST103");
    const reversed = await app.call("/rest/v1/notes", { headers: { range: "5-1" } });
    assertEquals(reversed.status, 416);
    await reversed.body?.cancel();
    const empty = await app.call("/rest/v1/notes?limit=0", { headers: { prefer: "count=exact" } });
    assertEquals([empty.status, empty.headers.get("content-range")], [206, "*/4"]);
    await empty.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("errors use the PostgREST envelope; unknown tables 404, other paths pass", async () => {
  const app = await restApp();
  try {
    const missing = await app.call("/rest/v1/secrets");
    assertEquals(missing.status, 404);
    const body = await missing.json();
    assertEquals(Object.keys(body).sort(), ["code", "details", "hint", "message"]);
    assertEquals(body.code, "PGRST205");
    for (const path of ["/rest/v1/notes/1", "/rest/v1/%E0%A4%A"]) {
      const res = await app.call(path);
      assertEquals(res.status, 404, path);
      assertEquals((await res.json()).code, "PGRST205");
    }
    const column = await app.call("/rest/v1/notes?nope=eq.1");
    assertEquals([column.status, (await column.json()).code], [400, "42703"]);
    const other = await app.call("/rest/v2/notes");
    assertEquals(other.status, 404);
    assert(!(await other.text()).includes("PGRST"));
    const put = await app.call("/rest/v1/notes", { method: "PUT" });
    assertEquals([put.status, put.headers.get("allow")], [405, "GET, HEAD, POST, PATCH, DELETE"]);
    assertEquals(app.seen.length, 0, "nothing reached the database");
  } finally {
    tearDown();
  }
});

Deno.test("POST inserts: minimal is 201 with no body, representation returns the rows", async () => {
  const app = await restApp(() => [{ body: '[{"id":7,"body":"hi"}]', n: "1" }]);
  try {
    const json = { "content-type": "application/json" };
    const minimal = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ body: "hi" }),
    });
    assertEquals([minimal.status, await minimal.text()], [201, ""]);
    assertStringIncludes(
      app.seen[0].text,
      `json_populate_recordset(NULL::"public"."notes", $1::json)`,
    );
    assertEquals(app.seen[0].params, ['[{"body":"hi"}]']);
    const full = await app.call("/rest/v1/notes?select=id,body", {
      method: "POST",
      headers: { ...json, prefer: "return=representation, count=exact" },
      body: JSON.stringify([{ body: "hi" }]),
    });
    assertEquals(full.status, 201);
    assertEquals(await full.json(), [{ id: 7, body: "hi" }]);
    assertEquals(full.headers.get("content-range"), "*/1");
    assertEquals(full.headers.get("preference-applied"), "return=representation, count=exact");
    assertStringIncludes(app.seen[1].text, `RETURNING t0."id", t0."body"`);
  } finally {
    tearDown();
  }
});

Deno.test("PATCH and DELETE need a filter; with one they answer 204 or the rows", async () => {
  const app = await restApp(() => [{ body: '[{"id":1}]', n: "1" }]);
  try {
    const unfiltered = await app.call("/rest/v1/notes", {
      method: "PATCH",
      body: JSON.stringify({ body: "x" }),
    });
    assertEquals([unfiltered.status, (await unfiltered.json()).code], [400, "21000"]);
    const everything = await app.call("/rest/v1/notes?select=id", { method: "DELETE" });
    assertEquals([everything.status, (await everything.json()).code], [400, "21000"]);
    assertEquals(app.seen.length, 0);
    const patched = await app.call("/rest/v1/notes?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ body: "x" }),
    });
    assertEquals(patched.status, 204);
    assertStringIncludes(app.seen[0].text, `UPDATE "public"."notes" AS t0 SET ("body")`);
    const deleted = await app.call("/rest/v1/notes?id=eq.1", {
      method: "DELETE",
      headers: { prefer: "return=representation" },
    });
    assertEquals([deleted.status, await deleted.text()], [200, '[{"id":1}]']);
  } finally {
    tearDown();
  }
});

Deno.test("cookie writes follow the Server Actions CSRF rule; cookieless and native bearer pass", async () => {
  const app = await restApp();
  try {
    const cookie = await cookieFor("user-a");
    const body = JSON.stringify({ body: "x" });
    const forged = await app.call("/rest/v1/notes", {
      method: "POST",
      body,
      cookie,
      crossSite: true,
    });
    assertEquals([forged.status, (await forged.json()).code], [403, "csrf_failed"]);
    const forgedDelete = await app.call("/rest/v1/notes?id=eq.1", {
      method: "DELETE",
      cookie,
      crossSite: true,
    });
    assertEquals(forgedDelete.status, 403);
    await forgedDelete.body?.cancel();
    assertEquals(app.seen.length, 0, "a refused write never reaches the database");
    const sameSite = await app.call("/rest/v1/notes", { method: "POST", body, cookie });
    assertEquals(sameSite.status, 201);
    const cookieless = await app.call("/rest/v1/notes", { method: "POST", body, crossSite: true });
    assertEquals(cookieless.status, 201);
    const bearer = await app.call("/rest/v1/notes", {
      method: "POST",
      body,
      cookie,
      crossSite: true,
      headers: { authorization: "Bearer nat_unknown.token" },
    });
    assertEquals(bearer.status, 201);
    // The bearer decides alone (an unknown one is signed out): never the page's cookie.
    assertEquals(app.seen.at(-1)!.role, "anon");
  } finally {
    tearDown();
  }
});

Deno.test("bodies: too large, not JSON, wrong type", async () => {
  const app = await restApp(undefined, { maxBodyBytes: 32 });
  try {
    const big = await app.call("/rest/v1/notes", {
      method: "POST",
      body: JSON.stringify({ body: "x".repeat(100) }),
    });
    assertEquals([big.status, (await big.json()).code], [413, "PGRST102"]);
    const broken = await app.call("/rest/v1/notes", { method: "POST", body: "{" });
    assertEquals(broken.status, 400);
    await broken.body?.cancel();
    const xml = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: "<a/>",
    });
    assertEquals(xml.status, 415);
    await xml.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("Postgres errors are mapped; a 5xx hides the database's message", async () => {
  let error: unknown;
  const app = await restApp(() => {
    throw error;
  });
  try {
    error = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      detail: "Key (id)=(1) already exists.",
    });
    const conflict = await app.call("/rest/v1/notes", { method: "POST", body: "{}" });
    assertEquals(conflict.status, 409);
    assertEquals(await conflict.json(), {
      code: "23505",
      message: "duplicate key value",
      details: "Key (id)=(1) already exists.",
      hint: null,
    });
    error = Object.assign(new Error("permission denied for table notes"), { code: "42501" });
    assertEquals((await app.call("/rest/v1/notes")).status, 403);
    error = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    assertEquals((await app.call("/rest/v1/notes")).status, 504);
    error = Object.assign(new Error("internal secret path /x"), { code: "XX000" });
    const { value: internal, logged } = await quiet(() => app.call("/rest/v1/notes"));
    assertEquals(internal.status, 500);
    assertEquals((await internal.json()).message, "database error");
    assertEquals(logged.length, 1);
    error = new Error("connection refused");
    const { value: down } = await quiet(() => app.call("/rest/v1/notes"));
    assertEquals([down.status, (await down.json()).code], [503, "PGRST001"]);
  } finally {
    tearDown();
  }
});

Deno.test("Accept: object returns one row; anything else is 406, and a write is rolled back", async () => {
  let rows = '[{"id":1}]';
  let n = "1";
  const app = await restApp(() => [{ body: rows, n }]);
  try {
    const accept = { accept: "application/vnd.pgrst.object+json" };
    const one = await app.call("/rest/v1/notes?id=eq.1", { headers: accept });
    assertEquals(await one.json(), { id: 1 });
    assertStringIncludes(one.headers.get("content-type")!, "vnd.pgrst.object+json");
    rows = '[{"id":1},{"id":2}]';
    n = "2";
    const two = await app.call("/rest/v1/notes", { headers: accept });
    assertEquals([two.status, (await two.json()).code], [406, "PGRST116"]);
    const write = await app.call("/rest/v1/notes?id=gt.0", {
      method: "PATCH",
      headers: { ...accept, prefer: "return=representation" },
      body: JSON.stringify({ body: "x" }),
    });
    assertEquals(write.status, 406);
    await write.body?.cancel();
    assertEquals(app.sql.statements.at(-1), "ROLLBACK");
  } finally {
    tearDown();
  }
});

Deno.test("tables: a list limits the routes; schema and basePath are configurable", async () => {
  const app = await restApp(undefined, { tables: ["other"], schema: "app", basePath: "/api/db/" });
  try {
    const res = await app.call("/api/db/notes");
    assertEquals([res.status, (await res.json()).message], [
      404,
      "Could not find the table 'app.notes' in the schema cache",
    ]);
  } finally {
    tearDown();
  }
});

Deno.test("resolveRest validates options; rest needs postgres", () => {
  assertEquals(resolveRest({}), {
    schemas: ["public"],
    tables: "*",
    basePath: "/rest/v1",
    maxRows: 1000,
    maxBodyBytes: 1024 * 1024,
    statementTimeout: 5000,
    maxConcurrent: undefined,
    exactCount: "authenticated",
    explain: false,
  });
  assertEquals(resolveRest({ schemas: ["a", "b", "a"], schema: "c" }).schemas, ["a", "b"]);
  const bad: RestOptions[] = [
    { schema: 'x"; drop' },
    { schemas: [] },
    { schemas: ["ok", "no-pe"] },
    { tables: [1 as unknown as string] },
    { tables: "all" as unknown as "*" },
    { basePath: "rest" },
    { basePath: "/" },
    { maxRows: 0 },
    { maxBodyBytes: 1.5 },
    { statementTimeout: -1 },
    { maxConcurrent: 0 },
    { exactCount: "anon" as unknown as "all" },
  ];
  for (const options of bad) {
    let threw = false;
    try {
      resolveRest(options);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, JSON.stringify(options));
  }
  let threw = false;
  try {
    backend({ rest: {} });
  } catch (error) {
    threw = (error as Error).message.includes("rest needs `postgres`");
  }
  assert(threw);
});

Deno.test("readRestCatalog groups columns and keys, and honours a table list", async () => {
  const rows = [...COLUMN_ROWS, { ...COLUMN_ROWS[0], table: "views_only", kind: "v" }];
  const sql = {
    unsafe: (text: string, params: unknown[]) => {
      if (params.length) assertEquals(params, ['["public"]']);
      return Promise.resolve(catalogAnswer(text, () => rows) ?? []);
    },
  } as never;
  const all = await readRestCatalog(sql, ["public"], "*");
  const tables = all.tables.get("public")!;
  assertEquals([...tables.keys()], ["notes", "views_only"]);
  const notes = tables.get("notes")!;
  assertEquals(notes.primaryKey, ["id"]);
  assertEquals(notes.columns.map((c) => c.name), ["id", "owner", "body", "size"]);
  assertEquals(notes.columns[3].readOnly, true);
  assertEquals(tables.get("views_only")!.kind, "view");
  assertEquals(tables.get("views_only")!.primaryKey, []);
  const listed = await readRestCatalog(sql, ["public"], ["public.views_only"]);
  assertEquals([...listed.tables.get("public")!.keys()], ["views_only"]);
});

Deno.test("the catalog cache: read once, retried after a failure, re-read on a dev miss", async () => {
  let reads = 0;
  let fail = true;
  const catalogOf = (tables: Map<string, unknown>) =>
    ({ tables: new Map([["public", tables]]) }) as unknown as RestCatalog;
  let tables = new Map<string, unknown>();
  const cache = new RestCatalogCache(() => {
    reads++;
    return fail ? Promise.reject(new Error("down")) : Promise.resolve(catalogOf(tables));
  }, true);
  let error: unknown;
  await cache.get().catch((e) => (error = e));
  assertEquals((error as Error).message, "down");
  fail = false;
  assertEquals(await cache.table("public", "notes"), undefined);
  assertEquals(
    reads,
    2,
    "a failed read is not remembered; a miss right after a read is not re-read",
  );
  tables = new Map([["notes", "N" as never]]);
  const now = Date.now;
  Date.now = () => now() + 5000;
  try {
    assertEquals(await cache.table("public", "notes"), "N" as never);
    assertEquals(reads, 3);
  } finally {
    Date.now = now;
  }
  const prod = new RestCatalogCache(
    () => (reads++, Promise.resolve(catalogOf(new Map()))),
    false,
  );
  await prod.table("public", "x");
  await prod.table("public", "x");
  assertEquals(reads, 4, "outside dev a miss never re-reads");
});

Deno.test(".denext/rest.ts: generated by the prepare step; a stub, or the previous file, without a database", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "dnx-rest-types-" });
  try {
    await restApp();
    try {
      await runPluginPrepareSteps({
        projectRoot: outDir,
        appDir: `${outDir}/app`,
        outDir,
        config: {} as DenextConfig,
      });
    } finally {
      tearDown();
    }
    const generated = await Deno.readTextFile(`${outDir}/rest.ts`);
    assertStringIncludes(generated, `notes: {`);
    assertStringIncludes(generated, `size: number | null;`);
    // A failed read keeps the generated file.
    const { logged } = await quiet(() =>
      writeRestTypes(outDir, {}, () => Promise.reject(new Error("no db")))
    );
    assertEquals(await Deno.readTextFile(`${outDir}/rest.ts`), generated);
    assertStringIncludes(String(logged[0][0]), "keeping the previous one");
    // With no earlier file, a stub that types rows as Record<string, unknown>.
    await Deno.remove(`${outDir}/rest.ts`);
    await quiet(() => writeRestTypes(outDir, {}, () => Promise.reject(new Error("no db"))));
    const stub = await Deno.readTextFile(`${outDir}/rest.ts`);
    assertStringIncludes(stub, "Record<string, unknown>");
    assertStringIncludes(stub, "no db");
    assert(!stub.includes("RegisteredRest"));
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

// Compile-time checks on the client's types (a failing one is a type error in this file).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;
type NoteRow = { id: number; body: string | null; owner: string };
const _star: Equal<Selected<NoteRow, "*">, NoteRow> = true;
const _cols: Equal<Selected<NoteRow, "id, body">, { id: number; body: string | null }> = true;
void [_star, _cols];

Deno.test("restClient drives the handler: filters, order, paging, count, single, writes, errors", async () => {
  const app = await restApp(
    (seen) =>
      seen.text.includes("count(*) FROM")
        ? [{ body: '[{"id":1},{"id":2}]', n: "2", total: "9" }]
        : seen.text.startsWith("WITH _m")
        ? [{ body: '[{"id":3}]', n: "1" }]
        : [{ body: '[{"id":1}]', n: "1" }],
    { exactCount: "all" },
  );
  try {
    const sent: Request[] = [];
    const rest = restClient({
      url: `${ORIGIN}/rest/v1/`,
      headers: { "x-app": "1" },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Request(String(input), init));
        return app.fetch(input, init);
      }) as typeof fetch,
    });
    const notes = rest.from("notes");
    const page = await notes.select("id,body", { count: "exact" })
      .eq("owner", "u, 1").gte("id", 2).in("id", [1, "a,b"]).is("body", null)
      .not("body", "like", "x*").ilike("body", "%y%").order("id", { ascending: false })
      .order("body", { nullsFirst: true }).limit(2).offset(4).range(0, 1);
    assertEquals({ ...page, data: page.data as unknown }, {
      data: [{ id: 1 }, { id: 2 }],
      error: null,
      count: 9,
      status: 206,
      statusText: "",
    });
    const url = new URL(sent[0].url);
    assertEquals(url.pathname, "/rest/v1/notes");
    assertEquals([...url.searchParams], [
      ["select", "id,body"],
      ["owner", "eq.u, 1"],
      ["id", "gte.2"],
      ["id", 'in.(1,"a,b")'],
      ["body", "is.null"],
      ["body", "not.like.x*"],
      ["body", "ilike.%y%"],
      ["order", "id.desc,body.asc.nullsfirst"],
      ["limit", "2"],
      ["offset", "0"],
    ]);
    assertEquals(sent[0].headers.get("prefer"), "count=exact");
    assertEquals(sent[0].headers.get("x-app"), "1");

    const one = await notes.select().eq("id", 1).single();
    assertEquals(one.data, { id: 1 });
    assertEquals(sent[1].headers.get("accept"), "application/vnd.pgrst.object+json");

    const inserted = await notes.insert({ body: "hi" }).select("id");
    assertEquals([inserted.status, inserted.data], [201, [{ id: 3 }]]);
    assertEquals(sent[2].headers.get("prefer"), "return=representation");
    assertEquals(sent[2].headers.get("content-type"), "application/json");
    assertEquals(await sent[2].json(), { body: "hi" });
    const updated = await notes.update({ body: "x" }).eq("id", 1);
    assertEquals([updated.status, updated.data, updated.error], [204, null, null]);
    assertEquals(sent[3].method, "PATCH");
    const removed = await notes.delete().lt("id", 0).lte("id", 0).gt("id", -5)
      .neq("owner", new Date(0)).eq("body", { a: 1 });
    assertEquals(removed.status, 204);
    assertEquals(new URL(sent[4].url).searchParams.getAll("owner"), [
      "neq.1970-01-01T00:00:00.000Z",
    ]);
    assertEquals(new URL(sent[4].url).searchParams.get("body"), 'eq.{"a":1}');
    const head = await notes.select("*", { head: true });
    assertEquals([head.status, head.data], [200, null]);

    const refused = await notes.delete();
    assert(refused.error instanceof RestClientError);
    assertEquals([refused.status, refused.error.code, refused.data], [400, "21000", null]);
    assert(refused.error.hint);
    const offline = await restClient({
      fetch: () => Promise.reject(new TypeError("offline")),
    }).from("notes").select();
    assertEquals([offline.status, offline.error?.code], [0, "network_error"]);
    const proxy = await restClient({
      fetch: () => Promise.resolve(new Response("bad gateway", { status: 502 })),
    }).from("notes").select();
    assertEquals([proxy.error?.code, proxy.error?.message], ["http_error", "bad gateway"]);
  } finally {
    tearDown();
  }
});

// ── Security defaults ────────────────────────────────────────────────────────

/** `notes`' column rows renamed to another relation of `kind`, with or without RLS. */
function relation(table: string, kind: string, rls: boolean): SqlRow[] {
  return COLUMN_ROWS.map((row) => ({ ...row, table, kind, rls: String(rls) }));
}

Deno.test('tables: "*" serves only RLS tables and security_invoker views; the rest are warned about', async () => {
  const rows = [
    ...COLUMN_ROWS,
    ...relation("open_table", "r", false),
    ...relation("parts", "p", true),
    ...relation("invoker_view", "v", true),
    ...relation("definer_view", "v", false),
    ...relation("matview", "m", false),
    ...relation("remote", "f", false),
  ];
  let sent = "";
  const sql = {
    unsafe: (text: string) => {
      if (text.includes("JOIN pg_attribute a ON a.attrelid = c.oid")) sent = text;
      return Promise.resolve(catalogAnswer(text, () => rows) ?? []);
    },
  } as never;
  // The catalog query reads RLS and security_invoker from pg_class.
  const skipped: unknown[] = [];
  const all = await readRestCatalog(sql, ["public"], "*", (s) => skipped.push(...s));
  assertStringIncludes(sent, "c.relrowsecurity");
  assertStringIncludes(sent, "security_invoker=");
  assertEquals([...all.tables.get("public")!.keys()], ["notes", "parts", "invoker_view"]);
  assertEquals(skipped, [
    {
      schema: "public",
      name: "open_table",
      kind: "table",
      reason: "row-level security is not enabled",
    },
    {
      schema: "public",
      name: "definer_view",
      kind: "view",
      reason: "a view without security_invoker runs with its owner's rights",
    },
    {
      schema: "public",
      name: "matview",
      kind: "materialized view",
      reason: "a materialized view has no row-level security",
    },
    {
      schema: "public",
      name: "remote",
      kind: "foreign table",
      reason: "a foreign table has no row-level security",
    },
  ]);
  // Naming them is the operator's choice: a list exposes them as named.
  const named = await readRestCatalog(sql, ["public"], ["open_table", "definer_view"], (s) => {
    assertEquals(s, []);
  });
  assertEquals([...named.tables.get("public")!.keys()], ["open_table", "definer_view"]);
  const warning = skippedWarning(skipped as never)!;
  assertStringIncludes(warning, "public.open_table (table): row-level security is not enabled");
  assertStringIncludes(warning, "public.remote (foreign table)");
  assertEquals(skippedWarning([]), null);
});

Deno.test("a table without RLS gets no route under the default, and one warning says why", async () => {
  const { value: app, logged } = await quiet(async () => {
    const app = await restApp(
      undefined,
      {},
      () => [...COLUMN_ROWS, ...relation("audit", "r", false)],
    );
    const open = await app.call("/rest/v1/audit");
    assertEquals([open.status, (await open.json()).code], [404, "PGRST205"]);
    const notes = await app.call("/rest/v1/notes");
    assertEquals(notes.status, 200);
    await notes.body?.cancel();
    return app;
  });
  try {
    const warnings = logged.map((args) => String(args[0])).filter((m) => m.includes("rest:"));
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "public.audit (table): row-level security is not enabled");
    assertEquals(app.seen.length, 1, "only the RLS table was queried");
  } finally {
    tearDown();
  }
});

Deno.test("count=exact is for signed-in users by default; exactCount: never refuses everyone", async () => {
  const counted = () => [{ body: '[{"id":1}]', n: "1", total: "1" }];
  let app = await restApp(counted);
  try {
    const anon = await app.call("/rest/v1/notes", { headers: { prefer: "count=exact" } });
    const body = await anon.json();
    assertEquals([anon.status, body.code], [400, "PGRST100"]);
    assertStringIncludes(body.message, "signed-in users");
    assertStringIncludes(body.hint, "limit / offset");
    assertEquals(app.seen.length, 0, "a refused count never reaches the database");
    const signedIn = await app.call("/rest/v1/notes", {
      headers: { prefer: "count=exact" },
      cookie: await cookieFor("user-a"),
    });
    assertEquals([signedIn.status, signedIn.headers.get("content-range")], [200, "0-0/1"]);
    await signedIn.body?.cancel();
    const plain = await app.call("/rest/v1/notes");
    assertEquals(plain.status, 200, "without count=exact anon reads as before");
    await plain.body?.cancel();
  } finally {
    tearDown();
  }
  app = await restApp(counted, { exactCount: "never" });
  try {
    const refused = await app.call("/rest/v1/notes", {
      headers: { prefer: "count=exact" },
      cookie: await cookieFor("user-a"),
    });
    assertEquals([refused.status, (await refused.json()).code], [400, "PGRST100"]);
  } finally {
    tearDown();
  }
});

Deno.test("StatementGate: at most max at once, waiters inherit a slot, a long wait is a 503", async () => {
  const gate = new StatementGate(1, 30);
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const first = gate.run(() => held.then(() => "first"));
  const timedOut = gate.run(() => Promise.resolve("never"));
  const error = await timedOut.then(() => null, (e) => e);
  assert(error instanceof RestError);
  assertEquals([error.status, error.code], [503, "PGRST003"]);
  const patient = new StatementGate(1, 10_000);
  let releaseP!: () => void;
  const heldP = new Promise<void>((resolve) => releaseP = resolve);
  const order: string[] = [];
  const a = patient.run(() => heldP.then(() => void order.push("a")));
  const b = patient.run(() => Promise.resolve().then(() => void order.push("b")));
  releaseP();
  await Promise.all([a, b]);
  assertEquals(order, ["a", "b"]);
  release();
  assertEquals(await first, "first");
  // The slot is free again.
  assertEquals(await gate.run(() => Promise.resolve(1)), 1);
  // Half the pool by default, at least one; 5 when the pool does not say; the option wins.
  assertEquals(concurrencyOf(resolveRest({}), 10), 5);
  assertEquals(concurrencyOf(resolveRest({}), 1), 1);
  assertEquals(concurrencyOf(resolveRest({}), undefined), 5);
  assertEquals(concurrencyOf(resolveRest({ maxConcurrent: 3 }), 40), 3);
});

Deno.test("REST statements beyond maxConcurrent wait, then 503 with Retry-After", async () => {
  const app = await restApp(undefined, { maxConcurrent: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const begin = app.sql.begin.bind(app.sql);
  let calls = 0;
  (app.sql as unknown as { begin: unknown }).begin = (fn: never) =>
    calls++ === 0 ? held.then(() => begin(fn)) : begin(fn);
  try {
    const slow = app.call("/rest/v1/notes");
    const turnedAway = await app.call("/rest/v1/notes");
    assertEquals(turnedAway.status, 503);
    assertEquals(turnedAway.headers.get("retry-after"), "1");
    assertEquals((await turnedAway.json()).code, "PGRST003");
    release();
    assertEquals((await slow).status, 200);
    const after = await app.call("/rest/v1/notes");
    assertEquals(after.status, 200, "the slot is free once the slow one finished");
    await after.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("the CSRF exemption is auth()'s own bearer parser: a cookie-authenticated look-alike is refused", async () => {
  const app = await restApp();
  try {
    const cookie = await cookieFor("user-a");
    // `auth()` does not read this as a native token, so the session comes from the cookie —
    // the write must face the cross-site check.
    const lookAlike = await app.call("/rest/v1/notes", {
      method: "POST",
      body: JSON.stringify({ body: "x" }),
      cookie,
      crossSite: true,
      headers: { authorization: "Bearer\tnat_unknown.token" },
    });
    assertEquals([lookAlike.status, (await lookAlike.json()).code], [403, "csrf_failed"]);
    assertEquals(app.seen.length, 0);
  } finally {
    tearDown();
  }
});

// ── PostgREST parity: functions, profiles, preferences, media types ─────────

/** One `TYPES_SQL` row. */
function typeRow(
  oid: string,
  name: string,
  category: string,
  extra: Partial<Record<string, string>> = {},
): SqlRow {
  return {
    oid,
    schema: "pg_catalog",
    name,
    cast_type: name,
    typtype: "b",
    type_name: name,
    category,
    element_name: null,
    element_category: null,
    enum_labels: null,
    relid: "0",
    relkind: "",
    rel_schema: "",
    rel_name: "",
    ...extra,
  };
}

/** One `FUNCTIONS_SQL` row. */
function functionRow(
  name: string,
  returnOid: string,
  args: Array<[string, string, string?]>,
  extra: Partial<Record<string, string | number>> = {},
): SqlRow {
  return {
    schema: "public",
    name,
    volatility: "s",
    set_of: "false",
    return_oid: returnOid,
    ndefaults: 0,
    args: JSON.stringify(args.map(([n, oid, mode]) => ({ name: n, oid, mode: mode ?? "i" }))),
    ...extra,
  };
}

/** A catalog with functions of every result kind. */
function withFunctions(): void {
  TYPE_ROWS = [
    typeRow("23", "int4", "N", { cast_type: "integer" }),
    typeRow("25", "text", "S"),
    typeRow("114", "json", "U"),
    typeRow("2278", "void", "P"),
    typeRow("2249", "record", "P"),
    typeRow("9000", "notes", "C", {
      schema: "public",
      typtype: "c",
      relid: "9001",
      relkind: "r",
      rel_schema: "public",
      rel_name: "notes",
    }),
    typeRow("9100", "pair", "C", { schema: "public", typtype: "c", relid: "9101", relkind: "c" }),
    typeRow("9200", "mood", "E", {
      schema: "public",
      typtype: "e",
      enum_labels: '["ok","sad"]',
    }),
  ];
  ATTRIBUTE_ROWS = [
    { relid: "9001", name: "id", type_oid: "23", nullable: "false" },
    { relid: "9001", name: "body", type_oid: "25", nullable: "true" },
    { relid: "9101", name: "a", type_oid: "23", nullable: "true" },
  ];
  FUNCTION_ROWS = [
    functionRow("add", "23", [["a", "23"], ["b", "23"]], { volatility: "i", ndefaults: 1 }),
    functionRow("touch", "2278", [], { volatility: "v" }),
    functionRow("notes_of", "9000", [["n", "23"]], { set_of: "true" }),
    functionRow("one_note", "9000", []),
    functionRow("echo", "114", [["", "114"]]),
    functionRow("pairf", "9100", []),
    functionRow("nums", "23", [], { set_of: "true" }),
    functionRow("stats", "2249", [["k", "25", "t"], ["v", "23", "t"]], { set_of: "true" }),
    functionRow("untyped", "2249", []),
  ];
}

/** Answers RPC statements by shape. */
function rpcResponder(seen: Seen): SqlRow[] {
  if (seen.text.startsWith("EXPLAIN")) return [{ "QUERY PLAN": [{ Plan: { "Plan Rows": 40 } }] }];
  if (seen.text.startsWith("SELECT count(*)::text AS n FROM (SELECT")) return [{ n: "1" }];
  if (seen.text.startsWith("SELECT to_json")) return [{ body: "3", n: "1" }];
  if (seen.text.includes(`"public"."nums"`)) return [{ body: "[1,2]", n: "2", total: "2" }];
  if (seen.text.includes(`"public"."one_note"`)) return [{ body: '[{"id":1}]', n: "1" }];
  if (seen.text.includes(`"public"."pairf"`)) return [{ body: "[]", n: "0" }];
  return [{ body: '[{"id":1},{"id":2}]', n: "2", total: "2" }];
}

Deno.test("rpc: scalars, void, sets, composites, single json argument, GET and HEAD", async () => {
  withFunctions();
  const app = await restApp(rpcResponder, { exactCount: "all" });
  try {
    const sum = await app.call("/rest/v1/rpc/add", {
      method: "POST",
      body: JSON.stringify({ a: 1, b: 2 }),
    });
    assertEquals([sum.status, await sum.text()], [200, "3"]);
    assertStringIncludes(app.seen[0].text, `"public"."add"("a" => (SELECT _a."a"`);
    assertEquals(app.seen[0].timeout, "5000");
    const get = await app.call("/rest/v1/rpc/add?a=1");
    assertEquals(get.status, 200);
    await get.body?.cancel();
    assertStringIncludes(app.seen[1].text, `"a" => $1::integer`);
    const tail = app.sql.statements.slice(-4);
    assertStringIncludes(tail[2], "transaction_read_only", "a GET call is READ ONLY");
    const voided = await app.call("/rest/v1/rpc/touch", { method: "POST" });
    assertEquals([voided.status, await voided.text()], [204, ""]);
    const set = await app.call("/rest/v1/rpc/notes_of?n=1&select=id&id=gt.0", {
      headers: { prefer: "count=exact" },
    });
    assertEquals([set.status, set.headers.get("content-range")], [200, "0-1/2"]);
    assertEquals(await set.json(), [{ id: 1 }, { id: 2 }]);
    assertStringIncludes(app.seen.at(-1)!.text, `t0."id" > $2::integer`);
    const one = await app.call("/rest/v1/rpc/one_note", { method: "POST", body: "{}" });
    assertEquals(await one.json(), { id: 1 });
    const none = await app.call("/rest/v1/rpc/pairf", { method: "POST", body: "{}" });
    assertEquals(await none.text(), "null");
    const nums = await app.call("/rest/v1/rpc/nums", { method: "HEAD" });
    assertEquals([nums.status, await nums.text()], [200, ""]);
    const echo = await app.call("/rest/v1/rpc/echo", { method: "POST", body: "[1,2]" });
    assertEquals(echo.status, 200);
    await echo.body?.cancel();
    assertStringIncludes(app.seen.at(-1)!.text, `"public"."echo"($1::json)`);
    const stats = await app.call("/rest/v1/rpc/stats?select=k");
    assertEquals(stats.status, 200);
    await stats.body?.cancel();
    const csv = await app.call("/rest/v1/rpc/one_note", {
      method: "POST",
      body: "{}",
      headers: { accept: "text/csv" },
    });
    assertEquals(await csv.text(), "id\n1\n");
    const objectScalar = await app.call("/rest/v1/rpc/add?a=1", {
      headers: { accept: "application/vnd.pgrst.object+json" },
    });
    assertEquals(objectScalar.status, 200);
    await objectScalar.body?.cancel();
    const planned = await app.call("/rest/v1/rpc/notes_of?n=1", {
      headers: { prefer: "count=planned" },
    });
    assertEquals(planned.headers.get("content-range"), "0-1/40");
    await planned.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("rpc refusals: unknown functions and arguments, select on a scalar, verbs", async () => {
  withFunctions();
  const app = await restApp(rpcResponder);
  try {
    const missing = await app.call("/rest/v1/rpc/nope", { method: "POST", body: "{}" });
    assertEquals([missing.status, (await missing.json()).code], [404, "PGRST202"]);
    const untyped = await app.call("/rest/v1/rpc/untyped", { method: "POST", body: "{}" });
    assertEquals(untyped.status, 404, "RETURNS record without OUT columns is not callable");
    await untyped.body?.cancel();
    const badArg = await app.call("/rest/v1/rpc/add", { method: "POST", body: '{"z":1}' });
    assertEquals([badArg.status, (await badArg.json()).code], [404, "PGRST202"]);
    const selectScalar = await app.call("/rest/v1/rpc/add?a=1&select=x");
    assertEquals([selectScalar.status, (await selectScalar.json()).code], [400, "PGRST100"]);
    const patch = await app.call("/rest/v1/rpc/add", { method: "PATCH", body: "{}" });
    assertEquals([patch.status, (await patch.json()).code], [405, "PGRST101"]);
    const forged = await app.call("/rest/v1/rpc/touch", {
      method: "POST",
      cookie: await cookieFor("user-a"),
      crossSite: true,
    });
    assertEquals(forged.status, 403, "a cookie-carrying cross-site call is a write");
    await forged.body?.cancel();
    const single = await app.call("/rest/v1/rpc/echo", {
      method: "POST",
      body: '{"x":1}',
      headers: { prefer: "params=single-object" },
    });
    assertEquals(single.headers.get("preference-applied"), "params=single-object");
    await single.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("profiles: Accept-Profile / Content-Profile pick an exposed schema", async () => {
  const app = await restApp(undefined, { schemas: ["public", "api"] });
  try {
    const read = await app.call("/rest/v1/notes", { headers: { "accept-profile": "public" } });
    assertEquals([read.status, read.headers.get("content-profile")], [200, "public"]);
    await read.body?.cancel();
    const other = await app.call("/rest/v1/notes", { headers: { "accept-profile": "api" } });
    assertEquals([other.status, (await other.json()).message], [
      404,
      "Could not find the table 'api.notes' in the schema cache",
    ]);
    const unknown = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { "content-profile": "secret" },
      body: "{}",
    });
    assertEquals([unknown.status, (await unknown.json()).code], [406, "PGRST106"]);
  } finally {
    tearDown();
  }
});

Deno.test("Prefer: strict handling, headers-only, tx=rollback, max-affected, planned counts", async () => {
  let n = "1";
  const app = await restApp((seen) =>
    seen.text.startsWith("EXPLAIN")
      ? [{ "QUERY PLAN": JSON.stringify([{ Plan: { "Plan Rows": 5000 } }]) }]
      : [{ body: '[{"id":7}]', n, total: "1" }]
  );
  try {
    const strict = await app.call("/rest/v1/notes", {
      headers: { prefer: "handling=strict, return=what" },
    });
    assertEquals([strict.status, (await strict.json()).code], [400, "PGRST122"]);
    const lenient = await app.call("/rest/v1/notes", {
      headers: { prefer: "return=what, timezone=UTC" },
    });
    assertEquals(lenient.status, 200);
    await lenient.body?.cancel();
    const location = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { prefer: "return=headers-only" },
      body: JSON.stringify({ body: "x" }),
    });
    assertEquals([location.status, location.headers.get("location")], [201, "/notes?id=eq.7"]);
    assertStringIncludes(app.seen.at(-1)!.text, `RETURNING t0."id"`);
    const rolled = await app.call("/rest/v1/notes?id=eq.1", {
      method: "PATCH",
      headers: { prefer: "tx=rollback, return=representation" },
      body: JSON.stringify({ body: "x" }),
    });
    assertEquals([rolled.status, rolled.headers.get("preference-applied")], [
      200,
      "tx=rollback, return=representation",
    ]);
    await rolled.body?.cancel();
    assertEquals(app.sql.statements.at(-1), "ROLLBACK");
    n = "3";
    const affected = await app.call("/rest/v1/notes?id=gt.0", {
      method: "DELETE",
      headers: { prefer: "handling=strict, max-affected=2" },
    });
    assertEquals([affected.status, (await affected.json()).code], [400, "PGRST124"]);
    assertStringIncludes(app.seen.at(-1)!.text, "RETURNING 1) SELECT count(*)");
    const counted = await app.call("/rest/v1/notes?id=gt.0", {
      method: "DELETE",
      headers: { prefer: "count=exact" },
    });
    assertEquals([counted.status, counted.headers.get("content-range")], [204, "*/3"]);
    n = "1";
    const planned = await app.call("/rest/v1/notes", { headers: { prefer: "count=planned" } });
    assertEquals(planned.headers.get("content-range"), "0-0/5000");
    await planned.body?.cancel();
    const estimated = await app.call("/rest/v1/notes", { headers: { prefer: "count=estimated" } });
    assertEquals(estimated.headers.get("content-range"), "0-0/5000", "over maxRows: the plan");
    await estimated.body?.cancel();
    const limited = await app.call("/rest/v1/notes?id=eq.1&limit=1", { method: "DELETE" });
    assertEquals([limited.status, (await limited.json()).code], [400, "PGRST100"]);
  } finally {
    tearDown();
  }
});

Deno.test("media: CSV, stripped nulls, GeoJSON without PostGIS, plans off and on", async () => {
  const app = await restApp((seen) =>
    seen.text.startsWith("EXPLAIN")
      ? [{ "QUERY PLAN": "Seq Scan on notes" }, { "QUERY PLAN": "  Filter: x" }]
      : [{ body: '[{"id":1,"body":"a, b"}]', n: "1" }]
  );
  try {
    const csv = await app.call("/rest/v1/notes", { headers: { accept: "text/csv" } });
    assertEquals([csv.headers.get("content-type"), await csv.text()], [
      "text/csv; charset=utf-8",
      'id,body\n1,"a, b"\n',
    ]);
    const stripped = await app.call("/rest/v1/notes", {
      headers: { accept: "application/vnd.pgrst.array+json;nulls=stripped" },
    });
    await stripped.body?.cancel();
    assertStringIncludes(app.seen.at(-1)!.text, "json_strip_nulls");
    const any = await app.call("/rest/v1/notes", { headers: { accept: "text/html, */*;q=0.1" } });
    assertEquals(any.status, 200);
    await any.body?.cancel();
    const html = await app.call("/rest/v1/notes", { headers: { accept: "text/html" } });
    assertEquals([html.status, (await html.json()).code], [406, "PGRST107"]);
    const geo = await app.call("/rest/v1/notes", { headers: { accept: "application/geo+json" } });
    assertEquals([geo.status, (await geo.json()).code], [406, "PGRST107"]);
    const plan = await app.call("/rest/v1/notes", {
      headers: { accept: 'application/vnd.pgrst.plan+text; for="application/json"' },
    });
    assertEquals([plan.status, (await plan.json()).code], [406, "PGRST107"]);
    const csvIn = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "body\nx\ny\n",
    });
    assertEquals(csvIn.status, 201);
    assertEquals(JSON.parse(app.seen.at(-1)!.params[0] as string), [{ body: "x" }, { body: "y" }]);
    const form = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "body=z",
    });
    assertEquals(form.status, 201);
    assertEquals(JSON.parse(app.seen.at(-1)!.params[0] as string), [{ body: "z" }]);
  } finally {
    tearDown();
  }
  const explaining = await restApp(
    (seen) =>
      seen.text.startsWith("EXPLAIN")
        ? [{ "QUERY PLAN": "Seq Scan on notes" }, { "QUERY PLAN": "  Filter: x" }]
        : [{ body: "[]", n: "0" }],
    { explain: true },
  );
  try {
    const text = await explaining.call("/rest/v1/notes?id=eq.1", {
      headers: {
        accept: 'application/vnd.pgrst.plan+text; for="application/json"; options=analyze|verbose',
      },
    });
    assertEquals(await text.text(), "Seq Scan on notes\n  Filter: x");
    assertStringIncludes(
      explaining.seen.at(-1)!.text,
      "EXPLAIN (FORMAT TEXT, ANALYZE, VERBOSE) SELECT",
    );
    assertEquals(explaining.sql.statements.at(-1), "ROLLBACK", "an analyzed plan never commits");
    const json = await explaining.call("/rest/v1/notes?id=eq.1", {
      method: "DELETE",
      headers: { accept: "application/vnd.pgrst.plan+json" },
    });
    assertEquals(
      json.headers.get("content-type"),
      `application/vnd.pgrst.plan+json; for="application/json"; charset=utf-8`,
    );
    assertEquals(await json.text(), "Seq Scan on notes");
    const badOption = await explaining.call("/rest/v1/notes", {
      headers: { accept: "application/vnd.pgrst.plan; options=drop" },
    });
    assertEquals(badOption.status, 406);
    await badOption.body?.cancel();
    const rpcPlan = await explaining.call("/rest/v1/notes", {
      headers: { accept: "application/vnd.pgrst.plan" },
    });
    assertEquals(rpcPlan.status, 200);
    await rpcPlan.body?.cancel();
  } finally {
    tearDown();
  }
});

Deno.test("writes: upserts, columns=, missing=default reach the statement", async () => {
  const app = await restApp(() => [{ body: "[]", n: "0" }]);
  try {
    const upsert = await app.call("/rest/v1/notes?on_conflict=id&columns=id,body", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates, missing=default, count=exact" },
      body: JSON.stringify([{ id: 1 }, { id: 2, body: "b" }]),
    });
    assertEquals(upsert.status, 201);
    assertEquals(
      upsert.headers.get("preference-applied"),
      "resolution=merge-duplicates, missing=default, count=exact",
    );
    const text = app.seen.at(-1)!.text;
    assertStringIncludes(text, `ON CONFLICT ("id") DO UPDATE SET "body" = EXCLUDED."body"`);
    assertStringIncludes(text, "DEFAULT)");
    const ignore = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ id: 1 }),
    });
    assertEquals(ignore.status, 201);
    assertStringIncludes(app.seen.at(-1)!.text, `ON CONFLICT ("id") DO NOTHING`);
    const patchColumns = await app.call("/rest/v1/notes?id=eq.1&columns=body", {
      method: "PATCH",
      headers: { prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ body: "x", owner: "y" }),
    });
    assertEquals([patchColumns.status, patchColumns.headers.get("preference-applied")], [
      204,
      null,
    ]);
    assertStringIncludes(app.seen.at(-1)!.text, `SET ("body")`);
  } finally {
    tearDown();
  }
});

Deno.test("restClient speaks supabase-js's wire format: every filter, transform and write", async () => {
  const sent: Request[] = [];
  let reply = () => new Response("[]", { status: 200 });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(String(input), init));
    return Promise.resolve(reply());
  }) as typeof globalThis.fetch;
  const rest = restClient({ url: "https://x.test/rest/v1", fetch });
  const last = () => sent.at(-1)!;
  const params = () => [...new URL(last().url).searchParams];
  await rest.from("t").select("a, b:c ,  d(e)").contains("tags", ["a", "b c"])
    .contains("meta", { k: 1 }).contains("r", "[1,2)").containedBy("tags", ["x"])
    .overlaps("tags", ["y"]).overlaps("r", "[1,3)").rangeGt("r", "[1,2)").rangeGte("r", "[1,2)")
    .rangeLt("r", "[1,2)").rangeLte("r", "[1,2)").rangeAdjacent("r", "[1,2)")
    .textSearch("s", "cat & dog").textSearch("s", "cat", { type: "plain", config: "english" })
    .textSearch("s", "a b", { type: "phrase" }).textSearch("s", "x", { type: "websearch" })
    .likeAllOf("n", ["a*", "*b"]).likeAnyOf("n", ["c"]).ilikeAllOf("n", ["d"])
    .ilikeAnyOf("n", ["e"]).regexMatch("n", "^a").regexIMatch("n", "^b")
    .isDistinct("n", "z").notIn("id", [1, 2]).match({ x: 1, y: "two" })
    .filter("n", "eq", "f").or("a.eq.1,b.eq.2").or("c.eq.3", { referencedTable: "d" })
    .order("e", { referencedTable: "d", ascending: false }).limit(5, { foreignTable: "d" })
    .range(10, 19, { referencedTable: "d" });
  assertEquals(params(), [
    ["select", "a,b:c,d(e)"],
    ["tags", 'cs.{a,"b c"}'],
    ["meta", 'cs.{"k":1}'],
    ["r", "cs.[1,2)"],
    ["tags", "cd.{x}"],
    ["tags", "ov.{y}"],
    ["r", "ov.[1,3)"],
    ["r", "sr.[1,2)"],
    ["r", "nxl.[1,2)"],
    ["r", "sl.[1,2)"],
    ["r", "nxr.[1,2)"],
    ["r", "adj.[1,2)"],
    ["s", "fts.cat & dog"],
    ["s", "plfts(english).cat"],
    ["s", "phfts.a b"],
    ["s", "wfts.x"],
    ["n", "like(all).{a*,*b}"],
    ["n", "like(any).{c}"],
    ["n", "ilike(all).{d}"],
    ["n", "ilike(any).{e}"],
    ["n", "match.^a"],
    ["n", "imatch.^b"],
    ["n", "isdistinct.z"],
    ["id", "not.in.(1,2)"],
    ["x", "eq.1"],
    ["y", "eq.two"],
    ["n", "eq.f"],
    ["or", "(a.eq.1,b.eq.2)"],
    ["d.or", "(c.eq.3)"],
    ["d.order", "e.desc"],
    ["d.limit", "10"],
    ["d.offset", "10"],
  ]);
  await rest.from("t").select().csv();
  assertEquals(last().headers.get("accept"), "text/csv");
  await rest.from("t").select().geojson();
  assertEquals(last().headers.get("accept"), "application/geo+json");
  reply = () => new Response("Seq Scan", { status: 200 });
  const plan = await rest.from("t").select().explain({ analyze: true, verbose: true });
  assertEquals(plan.data, "Seq Scan");
  assertEquals(
    last().headers.get("accept"),
    'application/vnd.pgrst.plan+text; for="application/json"; options=analyze|verbose;',
  );
  reply = () => new Response("[]", { status: 200 });
  await rest.from("t").update({ a: 1 }).eq("id", 1).rollback().maxAffected(3)
    .setHeader("x-trace", "1").returns<unknown>();
  assertEquals(last().headers.get("prefer"), "tx=rollback,handling=strict,max-affected=3");
  assertEquals(last().headers.get("x-trace"), "1");
  await rest.from("t").insert([{ a: 1 }, { b: 2 }], { count: "exact", defaultToNull: false });
  assertEquals(params(), [["columns", '"a","b"']]);
  assertEquals(last().headers.get("prefer"), "count=exact,missing=default");
  await rest.from("t").upsert({ a: 1 }, { onConflict: "a", ignoreDuplicates: true }).select("a");
  assertEquals(params(), [["on_conflict", "a"], ["select", "a"]]);
  assertEquals(
    last().headers.get("prefer"),
    "resolution=ignore-duplicates,return=representation",
  );
  await rest.from("t").upsert([{ a: 1 }]);
  assertEquals(last().headers.get("prefer"), "resolution=merge-duplicates");
  await rest.from("t").delete({ count: "planned" }).eq("id", 1);
  assertEquals([last().method, last().headers.get("prefer")], ["DELETE", "count=planned"]);
  await rest.rpc("fn", { a: 1, list: [1, 2], skip: undefined }, { get: true, count: "exact" });
  assertEquals([last().method, params()], ["GET", [["a", "1"], ["list", "{1,2}"]]]);
  await rest.rpc("fn", {}, { head: true });
  assertEquals(last().method, "HEAD");
  await rest.rpc("fn", { a: 1 });
  assertEquals([last().method, await last().json()], ["POST", { a: 1 }]);
  await rest.schema("api").from("t").select();
  assertEquals(last().headers.get("accept-profile"), "api");
  await rest.schema("api").rpc("fn");
  assertEquals(last().headers.get("content-profile"), "api");
  reply = () => new Response('[{"a":1},{"a":2}]', { status: 200 });
  const many = await rest.from("t").select().maybeSingle();
  assertEquals([many.status, many.error?.code], [406, "PGRST116"]);
  reply = () => new Response('[{"a":1}]', { status: 200 });
  assertEquals((await rest.from("t").select().maybeSingle()).data, { a: 1 });
  reply = () => new Response("[]", { status: 200 });
  assertEquals((await rest.from("t").select().maybeSingle()).data, null);
  reply = () =>
    new Response('{"code":"PGRST201","message":"m","details":[{"a":1}],"hint":"h"}', {
      status: 300,
    });
  const ambiguous = await rest.from("t").select("a(b)");
  assertEquals([ambiguous.error?.code, ambiguous.error?.details], ["PGRST201", '[{"a":1}]']);
  let thrown: unknown;
  try {
    await rest.from("t").select().throwOnError();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof RestClientError);
  const offline = restClient({
    url: "https://x.test",
    fetch: () => Promise.reject(new Error("x")),
  });
  let offlineThrown: unknown;
  try {
    await offline.from("t").select().throwOnError();
  } catch (error) {
    offlineThrown = error;
  }
  assertEquals((offlineThrown as RestClientError).code, "network_error");
  const controller = new AbortController();
  reply = () => new Response(null, { status: 204 });
  const aborted = await rest.from("t").delete().eq("id", 1).abortSignal(controller.signal);
  assertEquals([aborted.status, aborted.statusText, aborted.data], [204, "No Content", null]);
  assertEquals(last().signal.aborted, false);
});

Deno.test("Supabase keys and access tokens: the shared identity, 401s, CSRF, exact counts", async () => {
  const g = await generateSupabaseKeys();
  const keys = await resolveSupabaseKeys({
    publishableKey: g.publishableKey,
    secretKey: g.secretKey,
    signingKeys: g.signingKey,
  });
  const now = () => Math.floor(Date.now() / 1000);
  const token = (exp: number) =>
    signSupabaseJwt(keys, { sub: "user-j", role: "authenticated", aud: "authenticated", exp });
  installSupabaseKeys(keys);
  const app = await restApp(() => [{ body: '[{"id":1}]', n: "1", total: "1" }]);
  try {
    const anon = await app.call("/rest/v1/notes", { headers: { apikey: g.publishableKey } });
    assertEquals(anon.status, 200);
    await anon.body?.cancel();
    assertEquals(app.seen.at(-1)!.role, "anon");
    const user = await app.call("/rest/v1/notes", {
      headers: {
        apikey: g.publishableKey,
        authorization: `Bearer ${await token(now() + 600)}`,
        prefer: "count=exact",
      },
    });
    assertEquals(user.status, 200, "a signed-in token may count exactly");
    await user.body?.cancel();
    assertEquals([app.seen.at(-1)!.role, app.seen.at(-1)!.claims.sub], ["authenticated", "user-j"]);
    const expired = await app.call("/rest/v1/notes", {
      headers: { authorization: `Bearer ${await token(now() - 600)}` },
    });
    assertEquals([expired.status, (await expired.json()).code], [401, "PGRST303"]);
    const bad = await app.call("/rest/v1/notes", { headers: { apikey: "sb_publishable_nope" } });
    assertEquals([bad.status, (await bad.json()).code], [401, "PGRST301"]);
    assertEquals(bad.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
    const seen = app.seen.length;
    const service = await app.call("/rest/v1/notes?id=eq.1", {
      method: "DELETE",
      cookie: await cookieFor("user-a"),
      crossSite: true,
      headers: { apikey: g.secretKey, authorization: `Bearer ${g.secretKey}` },
    });
    assertEquals(service.status, 204, "the secret key decides: no cookie, no CSRF check");
    assertEquals(app.seen.length, seen + 1);
    assertEquals(app.seen.at(-1)!.claims.role, "service_role");
    const jwtWrite = await app.call("/rest/v1/notes", {
      method: "POST",
      body: "{}",
      cookie: await cookieFor("user-a"),
      crossSite: true,
      headers: { authorization: `Bearer ${await token(now() + 600)}` },
    });
    assertEquals(jwtWrite.status, 201);
    const cookieWrite = await app.call("/rest/v1/notes", {
      method: "POST",
      body: "{}",
      cookie: await cookieFor("user-a"),
      crossSite: true,
      headers: { apikey: g.publishableKey },
    });
    assertEquals(cookieWrite.status, 403, "the publishable key does not lift the cookie rule");
    await cookieWrite.body?.cancel();
  } finally {
    installSupabaseKeys(undefined);
    tearDown();
  }
});
