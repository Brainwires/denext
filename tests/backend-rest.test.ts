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
import { readRestCatalog } from "../packages/backend/src/rest-catalog.ts";
import { resolveRest, RestCatalogCache } from "../packages/backend/src/rest.ts";
import { writeRestTypes } from "../packages/backend/src/rest-codegen.ts";
import { restClient, RestClientError, type Selected } from "../packages/backend/client.ts";
import { type FakeSqlClient, fakeSqlClient } from "./helpers/fake-sql-client.ts";

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
  table: "notes",
  kind: "r",
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
const KEY_ROWS: SqlRow[] = [{ table: "notes", name: "id" }];

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
    if (text.includes("FROM pg_attribute") || text.includes("JOIN pg_attribute a ON a.attrelid")) {
      return catalog();
    }
    if (text.includes("i.indisprimary")) return KEY_ROWS;
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
    if (!/pg_attribute|indisprimary|^SELECT coalesce|^WITH _m|^INSERT|^UPDATE|^DELETE/.test(text)) {
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
    assertEquals([run.role, run.claims.role, run.timeout], ["anon", "anon", "8000"]);
    assertStringIncludes(
      run.text,
      `SELECT "id", "body" FROM "public"."notes" WHERE "id" > $1::integer`,
    );
    assertStringIncludes(run.text, `ORDER BY "id" DESC LIMIT 5`);
    assertEquals(run.params, ["0"]);
    // BEGIN, the RLS setup, the timeout and the query, then COMMIT: one transaction.
    const tail = app.sql.statements.slice(-4);
    assertEquals(tail[0], "BEGIN");
    assertStringIncludes(tail[2], "statement_timeout");
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
    { maxRows: 3, statementTimeout: 250 },
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
  const app = await restApp(() => [{ body: "[]", n: "0", total: "4" }]);
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
      `json_populate_record(NULL::"public"."notes", $1::json)`,
    );
    assertEquals(app.seen[0].params, ['{"body":"hi"}']);
    const full = await app.call("/rest/v1/notes?select=id,body", {
      method: "POST",
      headers: { ...json, prefer: "return=representation, count=exact" },
      body: JSON.stringify([{ body: "hi" }]),
    });
    assertEquals(full.status, 201);
    assertEquals(await full.json(), [{ id: 7, body: "hi" }]);
    assertEquals(full.headers.get("content-range"), "*/1");
    assertEquals(full.headers.get("preference-applied"), "return=representation, count=exact");
    assertStringIncludes(app.seen[1].text, `RETURNING "id", "body"`);
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
    assertStringIncludes(app.seen[0].text, `UPDATE "public"."notes" SET ("body")`);
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
    const form = await app.call("/rest/v1/notes", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "a,b",
    });
    assertEquals(form.status, 415);
    await form.body?.cancel();
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
      "Could not find the table 'app.notes'",
    ]);
  } finally {
    tearDown();
  }
});

Deno.test("resolveRest validates options; rest needs postgres", () => {
  assertEquals(resolveRest({}), {
    schema: "public",
    tables: "*",
    basePath: "/rest/v1",
    maxRows: 1000,
    maxBodyBytes: 1024 * 1024,
    statementTimeout: 8000,
  });
  const bad: RestOptions[] = [
    { schema: 'x"; drop' },
    { tables: [1 as unknown as string] },
    { tables: "all" as unknown as "*" },
    { basePath: "rest" },
    { basePath: "/" },
    { maxRows: 0 },
    { maxBodyBytes: 1.5 },
    { statementTimeout: -1 },
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
      assertEquals(params, ["public"]);
      return Promise.resolve(text.includes("indisprimary") ? KEY_ROWS : rows);
    },
  } as never;
  const all = await readRestCatalog(sql, "public", "*");
  assertEquals([...all.keys()], ["notes", "views_only"]);
  const notes = all.get("notes")!;
  assertEquals(notes.primaryKey, ["id"]);
  assertEquals(notes.columns.map((c) => c.name), ["id", "owner", "body", "size"]);
  assertEquals(notes.columns[3].readOnly, true);
  assertEquals(all.get("views_only")!.kind, "view");
  assertEquals(all.get("views_only")!.primaryKey, []);
  assertEquals([...(await readRestCatalog(sql, "public", ["views_only"])).keys()], ["views_only"]);
});

Deno.test("the catalog cache: read once, retried after a failure, re-read on a dev miss", async () => {
  let reads = 0;
  let fail = true;
  let tables = new Map<string, never>();
  const cache = new RestCatalogCache(() => {
    reads++;
    return fail ? Promise.reject(new Error("down")) : Promise.resolve(tables);
  }, true);
  let error: unknown;
  await cache.get().catch((e) => (error = e));
  assertEquals((error as Error).message, "down");
  fail = false;
  assertEquals(await cache.table("notes"), undefined);
  assertEquals(
    reads,
    2,
    "a failed read is not remembered; a miss right after a read is not re-read",
  );
  tables = new Map([["notes", "N" as never]]);
  const now = Date.now;
  Date.now = () => now() + 5000;
  try {
    assertEquals(await cache.table("notes"), "N" as never);
    assertEquals(reads, 3);
  } finally {
    Date.now = now;
  }
  const prod = new RestCatalogCache(() => (reads++, Promise.resolve(new Map())), false);
  await prod.table("x");
  await prod.table("x");
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
    assertStringIncludes(generated, `"notes": {`);
    assertStringIncludes(generated, `"size": number | null;`);
    // A failed read keeps the generated file.
    const { logged } = await quiet(() =>
      writeRestTypes(outDir, { schema: "public" }, () => Promise.reject(new Error("no db")))
    );
    assertEquals(await Deno.readTextFile(`${outDir}/rest.ts`), generated);
    assertStringIncludes(String(logged[0][0]), "keeping the previous one");
    // With no earlier file, a stub that types rows as Record<string, unknown>.
    await Deno.remove(`${outDir}/rest.ts`);
    await quiet(() =>
      writeRestTypes(outDir, { schema: "public" }, () => Promise.reject(new Error("no db")))
    );
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
  const app = await restApp((seen) =>
    seen.text.includes("count(*) FROM")
      ? [{ body: '[{"id":1},{"id":2}]', n: "2", total: "9" }]
      : seen.text.startsWith("WITH _m")
      ? [{ body: '[{"id":3}]', n: "1" }]
      : [{ body: '[{"id":1}]', n: "1" }]
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
      ["offset", "4"],
    ]);
    assertEquals(sent[0].headers.get("prefer"), "count=exact");
    assertEquals(sent[0].headers.get("range"), "0-1");
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
