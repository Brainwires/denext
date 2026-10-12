// `denext db-admin` — the child behind `denext ui`'s Database section — answered in-process
// against a fake Postgres client (each catalog query matched by its text, every statement
// recorded) and a fake `@denext/backend` storage installed in the plugin's global slot. Covers:
// every operation's reply; that every query runs in a transaction that sets the statement
// timeout first, and a read's is `READ ONLY` first of all; that a write without `confirm` only
// previews (nothing but reads run) and with it runs the very statement it previewed; that
// `readOnly` refuses every write before any SQL; the "as user" preview's role and claims; and
// that a failure never carries the connection password. The real database is covered by
// tests/db-admin-integration.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SqlClient, SqlQuery } from "../src/server/postgres.ts";
import { handleDbRequest, type HandleDeps } from "../src/cli/db-admin/handle.ts";
import {
  type AdminConnection,
  ConnectionError,
  guardedClient,
  openConnection,
} from "../src/cli/db-admin/connection.ts";
import type { DbFailure, DbReplies, DbReply, DbRequest } from "../src/ui/database/protocol.ts";

/** One recorded statement. */
interface Sent {
  text: string;
  params: unknown[];
  tx: number;
}

/** A canned answer for statements whose text matches. */
type Rule = [RegExp, (params: unknown[]) => Record<string, unknown>[]];

/** The catalog of a database with `public.notes (id bigint pk, title text)` and auth tables. */
function catalogRules(): Rule[] {
  return [
    [/FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\s+WHERE c.relkind IN/, () => [
      {
        schema: "public",
        name: "notes",
        kind: "r",
        estimate: "2",
        rls: "false",
        forced: "false",
        has_pk: "true",
      },
      {
        schema: "public",
        name: "v",
        kind: "v",
        estimate: "-1",
        rls: "false",
        forced: "false",
        has_pk: "false",
      },
    ]],
    [/SELECT c.oid::text AS oid/, (p) =>
      p[0] === "public" && p[1] === "notes"
        ? [{
          oid: "100",
          schema: "public",
          name: "notes",
          kind: "r",
          estimate: "2",
          rls: "true",
          forced: "false",
          has_pk: "true",
        }]
        : []],
    [/FROM pg_attribute a/, () => [
      {
        name: "id",
        type: "bigint",
        cast_type: "bigint",
        nullable: "false",
        default: null,
        identity: "d",
        generated: "false",
      },
      {
        name: "title",
        type: "character varying(40)",
        cast_type: "character varying",
        nullable: "true",
        default: "'x'::text",
        identity: "",
        generated: "false",
      },
    ]],
    [/indisprimary ORDER BY k.ord/, () => [{ name: "id" }]],
    [/pg_get_indexdef/, () => [{ name: "notes_pkey", definition: "CREATE UNIQUE INDEX …" }]],
    [/pg_get_constraintdef/, () => []],
    [/FROM pg_policies/, () => [{
      schemaname: "public",
      tablename: "notes",
      policyname: "own",
      permissive: "PERMISSIVE",
      roles: "{authenticated}",
      cmd: "SELECT",
      qual: "(auth.uid() = owner)",
      with_check: null,
    }]],
    [/c.relname = 'auth_users'/, () => [{ schema: "public" }]],
    [
      /LIKE 'auth\\_%'/,
      () =>
        ["auth_users", "auth_sessions", "auth_mfa", "auth_passkeys", "auth_native_sessions"].map(
          (name) => ({ name }),
        ),
    ],
  ];
}

/** A fake client: matches rules, records every statement and which transaction it ran in. */
function fakeClient(rules: Rule[]): { sql: SqlClient; sent: Sent[]; closed: () => boolean } {
  const sent: Sent[] = [];
  let txCount = 0;
  let closed = false;
  const make = (tx: number): SqlClient => {
    const query = (text: string, params: unknown[] = []): SqlQuery => {
      const run = () => {
        sent.push({ text, params, tx });
        for (const [pattern, answer] of rules) {
          if (pattern.test(text)) return Promise.resolve(answer(params));
        }
        if (/pg_sleep|boom/.test(text)) {
          return Promise.reject(
            Object.assign(new Error("connect postgres://app:hunter2@db/x refused"), {
              code: "57014",
            }),
          );
        }
        return Promise.resolve([]);
      };
      return { then: (ok, fail) => run().then(ok, fail), simple: run } as SqlQuery;
    };
    const client =
      ((strings: TemplateStringsArray, ...values: unknown[]) =>
        query(strings.join("?"), values)) as unknown as SqlClient;
    client.unsafe = query as SqlClient["unsafe"];
    client.begin = async (fn) => await fn(make(++txCount));
    client.close = () => {
      closed = true;
      return Promise.resolve();
    };
    return client;
  };
  return { sql: make(0), sent, closed: () => closed };
}

/** Deps over a fake client. */
function deps(sql: SqlClient, projectDir = "/nowhere"): HandleDeps {
  const connection: AdminConnection = {
    sql,
    display: "postgres://app:•••@db:5432/x",
    source: "env",
    close: () => Promise.resolve(),
  };
  return { projectDir, connect: () => connection };
}

/** Ask, as the UI would. */
function ask<K extends keyof DbReplies = keyof DbReplies>(
  sql: SqlClient,
  request: DbRequest,
  readOnly = false,
  dir?: string,
): Promise<DbReply<K>> {
  return handleDbRequest({ readOnly, request }, deps(sql, dir)) as Promise<DbReply<K>>;
}

/** The statements that are not transaction setup. */
function work(sent: Sent[]): Sent[] {
  return sent.filter((s) => !/^SET |set_config\('role'/.test(s.text));
}

Deno.test("every transaction sets READ ONLY (for a read) and the timeouts before any query", async () => {
  const { sql, sent } = fakeClient(catalogRules());
  const reply = await ask(sql, { op: "overview" });
  assert(reply.ok);
  const byTx = new Map<number, string[]>();
  for (const s of sent) byTx.set(s.tx, [...byTx.get(s.tx) ?? [], s.text]);
  assert(byTx.size >= 1);
  for (const [tx, texts] of byTx) {
    assert(tx > 0, "nothing runs outside a transaction");
    assertEquals(texts[0], "SET TRANSACTION READ ONLY");
    assertEquals(texts[1], "SET LOCAL statement_timeout = 5000");
    assertStringIncludes(texts[2], "SET LOCAL lock_timeout");
  }
});

Deno.test("overview: tables, kinds, estimates, the auth schema and the masked connection", async () => {
  const { sql } = fakeClient(catalogRules());
  const reply = await ask<"overview">(sql, { op: "overview" });
  assert(reply.ok);
  assertEquals(reply.connection, "postgres://app:•••@db:5432/x");
  assertEquals(reply.tables.map((t) => [t.name, t.kind, t.estimate, t.hasPrimaryKey]), [
    ["notes", "table", 2, true],
    ["v", "view", null, false],
  ]);
  assertEquals(reply.authSchema, "public");
  assertEquals(reply.storage, false);
});

Deno.test("table: columns, key, indexes, policies from the catalog", async () => {
  const { sql } = fakeClient(catalogRules());
  const reply = await ask(sql, { op: "table", schema: "public", table: "notes" });
  assert(reply.ok && "table" in reply);
  assertEquals(reply.table.primaryKey, ["id"]);
  assertEquals(reply.table.columns[0].identity, "by default");
  assertEquals(reply.table.columns[1].castType, "character varying");
  assertEquals(reply.table.policies[0].name, "own");
  assertEquals(reply.table.rls, true);
  const missing = await ask(sql, { op: "table", schema: "public", table: "nope" });
  assertEquals((missing as DbFailure).code, "not_found");
});

Deno.test("rows: a keyset page, the next cursor, and the 'as user' role and claims", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: String(i + 1), title: `t${i}` }));
  const { sql, sent } = fakeClient([[/FROM "public"."notes"/, () => rows], ...catalogRules()]);
  const reply = await ask(sql, {
    op: "rows",
    schema: "public",
    table: "notes",
    actor: { kind: "user", id: "u1" },
  });
  assert(reply.ok && "rows" in reply);
  assertEquals(reply.rows.length, 50);
  assertEquals(reply.next, ["50"]);
  assertStringIncludes(reply.statement.text, 'ORDER BY "public"."notes"."id" ASC LIMIT 51');
  const scope = sent.find((s) => s.text.includes("set_config('role'"));
  assertEquals(scope?.params[0], "authenticated");
  assertEquals(JSON.parse(String(scope?.params[1])).sub, "u1");
  // The page read ran in the scoped transaction, the catalog in another, unscoped one.
  const page = sent.find((s) => s.text.includes('FROM "public"."notes"'))!;
  assertEquals(scope?.tx, page.tx);
  const catalog = sent.find((s) => s.text.includes("c.oid::text AS oid"))!;
  assert(catalog.tx !== page.tx);
  const bad = await ask(sql, { op: "rows", schema: "public", table: "notes", sort: "nope" });
  assertEquals((bad as DbFailure).code, "bad_request");
  const badActor = await ask(sql, {
    op: "rows",
    schema: "public",
    table: "notes",
    actor: { kind: "god" } as never,
  });
  assertEquals((badActor as DbFailure).code, "bad_request");
});

Deno.test("row: one row by its key", async () => {
  const { sql } = fakeClient([[
    /WHERE "id" = \$1::bigint LIMIT 1/,
    () => [{ id: "7", title: null }],
  ], ...catalogRules()]);
  const reply = await ask(sql, { op: "row", schema: "public", table: "notes", key: { id: "7" } });
  assert(reply.ok && "row" in reply);
  assertEquals(reply.row, { id: "7", title: null });
  const bad = await ask(sql, { op: "row", schema: "public", table: "notes", key: "7" as never });
  assertEquals((bad as DbFailure).code, "bad_request");
});

Deno.test("write: a preview builds the statement and runs only catalog reads", async () => {
  const { sql, sent } = fakeClient(catalogRules());
  const reply = await ask<"write">(sql, {
    op: "write",
    action: "update",
    schema: "public",
    table: "notes",
    key: { id: "7" },
    values: { title: "new" },
    confirm: false,
  });
  assert(reply.ok);
  assertEquals(reply.applied, false);
  assertEquals(
    reply.statement.text,
    'UPDATE "public"."notes" SET "title" = $1::character varying WHERE "id" = $2::bigint RETURNING "id"::text',
  );
  assertEquals(work(sent).some((s) => /^(UPDATE|INSERT|DELETE)/.test(s.text)), false);
  // Every transaction this preview opened was READ ONLY.
  assert(sent.filter((s) => s.text === "SET TRANSACTION READ ONLY").length >= 1);
});

Deno.test("write: confirm runs the previewed statement, exactly one row or nothing", async () => {
  const { sql, sent } = fakeClient([
    [/^UPDATE/, () => [{ id: "7" }]],
    [/^DELETE/, () => []],
    ...catalogRules(),
  ]);
  const request = {
    op: "write" as const,
    action: "update" as const,
    schema: "public",
    table: "notes",
    key: { id: "7" },
    values: { title: null },
    confirm: true,
  };
  const reply = await ask(sql, request);
  assert(reply.ok && "affected" in reply);
  assertEquals(reply.affected, 1);
  const update = sent.find((s) => s.text.startsWith("UPDATE"))!;
  assertEquals(update.text, reply.statement.text);
  assertEquals(update.params, [null, "7"]);
  // The write's transaction set the timeout, and was not READ ONLY.
  const txTexts = sent.filter((s) => s.tx === update.tx).map((s) => s.text);
  assertEquals(txTexts[0], "SET LOCAL statement_timeout = 5000");
  const gone = await ask(sql, { ...request, action: "delete", values: undefined });
  assertEquals((gone as DbFailure).code, "not_found");
  assertStringIncludes((gone as DbFailure).reason, "nothing was changed");
});

Deno.test("write: insert into a view, an unknown action and bad values are refused", async () => {
  const { sql } = fakeClient(catalogRules());
  const insert = await ask(sql, {
    op: "write",
    action: "insert",
    schema: "public",
    table: "notes",
    values: { title: "a" },
    confirm: false,
  });
  assert(insert.ok && "statement" in insert);
  const bad = await ask(sql, {
    op: "write",
    action: "insert",
    schema: "public",
    table: "notes",
    values: { title: 5 } as never,
    confirm: false,
  });
  assertEquals((bad as DbFailure).code, "bad_request");
  const unknown = await ask(sql, {
    op: "write",
    action: "truncate" as never,
    schema: "public",
    table: "notes",
    confirm: true,
  });
  assertEquals((unknown as DbFailure).code, "bad_request");
});

Deno.test("readOnly refuses every write before any SQL runs", async () => {
  const writes: DbRequest[] = [
    {
      op: "write",
      action: "delete",
      schema: "public",
      table: "notes",
      key: { id: "1" },
      confirm: true,
    },
    {
      op: "write",
      action: "update",
      schema: "public",
      table: "notes",
      key: { id: "1" },
      values: { title: "x" },
      confirm: false,
    },
    { op: "migrate", confirm: true },
    { op: "userAction", action: "delete", id: "u1", confirm: true },
    { op: "removeObject", bucket: "b", key: "k", confirm: true },
  ];
  for (const request of writes) {
    const { sql, sent } = fakeClient(catalogRules());
    const reply = await ask(sql, request, true);
    assertEquals((reply as DbFailure).code, "read_only", request.op);
    assertEquals(sent.length, 0, request.op);
  }
  // A missing flag is read-only too: the child fails safe.
  const { sql } = fakeClient(catalogRules());
  const reply = await handleDbRequest(
    { request: { op: "migrate", confirm: true } } as never,
    deps(sql),
  );
  assertEquals((reply as DbFailure).code, "read_only");
});

Deno.test("policies: tables (not views) and every policy", async () => {
  const { sql } = fakeClient(catalogRules());
  const reply = await ask(sql, { op: "policies" });
  assert(reply.ok && "policies" in reply);
  assertEquals(reply.tables.map((t) => t.name), ["notes"]);
  assertEquals(reply.policies[0].using, "(auth.uid() = owner)");
});

Deno.test("users: counts sessions, MFA and passkeys; revoke and delete preview then run", async () => {
  const user = {
    id: "u1",
    email: "a@b.c",
    name: null,
    roles: "[]",
    created_at: "1700000000",
    sessions: "2",
    mfa: "true",
    passkeys: "1",
  };
  const { sql, sent } = fakeClient([
    [/FROM "public"."auth_users" u/, () => [user]],
    [/SELECT 1 AS hit/, (p) => (p[0] === "u1" ? [{ hit: 1 }] : [])],
    ...catalogRules(),
  ]);
  const list = await ask(sql, { op: "users", query: "a%_" });
  assert(list.ok && "users" in list);
  assertEquals(list.users[0], {
    id: "u1",
    email: "a@b.c",
    name: null,
    roles: "[]",
    createdAt: 1700000000,
    sessions: 2,
    mfa: true,
    passkeys: 1,
  });
  const query = sent.find((s) => s.text.includes('"auth_users" u'))!;
  assertEquals(query.params, ["%a\\%\\_%"]);
  assertStringIncludes(query.text, '"public"."auth_native_sessions"');
  const revoke = await ask(sql, { op: "userAction", action: "revoke", id: "u1", confirm: false });
  assert(revoke.ok && "statements" in revoke);
  assertEquals(revoke.statements.map((s) => s.text.split(" ")[0]), ["DELETE", "UPDATE"]);
  assertEquals(work(sent).some((s) => s.text.startsWith("DELETE")), false);
  const del = await ask(sql, { op: "userAction", action: "delete", id: "u1", confirm: true });
  assert(del.ok && "applied" in del && del.applied);
  const deletes = sent.filter((s) => s.text.startsWith("DELETE")).map((s) => s.text);
  assertStringIncludes(deletes[deletes.length - 1], '"auth_users" WHERE id = $1');
  assertEquals(new Set(sent.filter((s) => s.text.startsWith("DELETE")).map((s) => s.tx)).size, 1);
  const missing = await ask(sql, {
    op: "userAction",
    action: "revoke",
    id: "nobody",
    confirm: true,
  });
  assertEquals((missing as DbFailure).code, "not_found");
});

Deno.test("users: a database without auth tables says so", async () => {
  const { sql } = fakeClient([[/c.relname = 'auth_users'/, () => []]]);
  const reply = await ask(sql, { op: "users" });
  assert(reply.ok && "users" in reply);
  assertEquals(reply.schema, null);
  const action = await ask(sql, { op: "userAction", action: "revoke", id: "u", confirm: false });
  assertEquals((action as DbFailure).code, "not_found");
});

Deno.test("migrations: status, the pending SQL, and apply under a guarded client", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "migrations"));
    await Deno.writeTextFile(join(dir, "migrations", "001_a.sql"), "CREATE TABLE a (id int);");
    await Deno.writeTextFile(join(dir, "migrations", "002_b.sql"), "CREATE TABLE b (id int);");
    const { sql, sent } = fakeClient([[
      /SELECT name, checksum, applied_at FROM "_migrations"/,
      () => [
        { name: "001_a.sql", checksum: "stale", applied_at: "2026-01-01T00:00:00Z" },
      ],
    ], [/SELECT 1 AS hit FROM "_migrations"/, () => []]]);
    const status = await ask(sql, { op: "migrations" }, false, dir);
    assert(status.ok && "migrations" in status);
    assertEquals(status.migrations.map((m) => [m.name, m.state]), [
      ["001_a.sql", "changed"],
      ["002_b.sql", "pending"],
    ]);
    assertEquals(status.pendingSql, [{ name: "002_b.sql", sql: "CREATE TABLE b (id int);" }]);
    const preview = await ask(sql, { op: "migrate", confirm: false }, false, dir);
    assert(preview.ok && "applied" in preview);
    assertEquals(preview.applied, []);
    assertEquals(sent.some((s) => s.text.includes("CREATE TABLE b")), false);
    const run = await ask(sql, { op: "migrate", confirm: true }, false, dir);
    assert(run.ok && "applied" in run);
    assertEquals(run.applied, ["002_b.sql"]);
    const create = sent.find((s) => s.text.includes("CREATE TABLE b"))!;
    const txTexts = sent.filter((s) => s.tx === create.tx).map((s) => s.text);
    assertEquals(txTexts[0], "SET LOCAL statement_timeout = 60000");
    const none = await ask(sql, { op: "migrations" }, false, join(dir, "nope"));
    assert(none.ok && "migrations" in none);
    assertEquals(none.migrations, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed query is query_failed with its SQLSTATE and no password", async () => {
  const { sql } = fakeClient([[/FROM pg_class/, () => {
    throw Object.assign(new Error("boom postgres://app:hunter2@db/x"), { code: "42501" });
  }]]);
  const reply = await ask(sql, { op: "overview" });
  assertEquals((reply as DbFailure).code, "query_failed");
  assertStringIncludes((reply as DbFailure).reason, "SQLSTATE 42501");
  assertEquals((reply as DbFailure).reason.includes("hunter2"), false);
});

Deno.test("no request, an unknown op, and no connection are explained", async () => {
  const { sql } = fakeClient([]);
  assertEquals(((await handleDbRequest({} as never, deps(sql))) as DbFailure).code, "bad_request");
  assertEquals(((await ask(sql, { op: "drop" } as never)) as DbFailure).code, "bad_request");
  const reply = await handleDbRequest({ readOnly: true, request: { op: "overview" } }, {
    projectDir: "/x",
    connect: () => {
      throw new ConnectionError("not_configured", "no database");
    },
  });
  assertEquals((reply as DbFailure).code, "not_configured");
});

Deno.test("openConnection: the backend's client first, else DATABASE_URL, else why not", () => {
  const SLOT = Symbol.for("denext.backend.postgres");
  const holder = globalThis as { [SLOT]?: unknown };
  const before = holder[SLOT];
  try {
    const { sql } = fakeClient([]);
    holder[SLOT] = { sql };
    const backend = openConnection(() => "postgres://u:pw@h/d");
    assertEquals(backend.source, "backend");
    assertEquals(backend.display.includes("pw"), false);
    holder[SLOT] = { error: new Error("no Deno.SQL for postgres://u:pw@h/d") };
    let caught: unknown;
    try {
      openConnection(() => undefined);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof ConnectionError);
    assertEquals(caught.code, "unsupported");
    assertEquals(caught.message.includes(":pw@"), false);
    holder[SLOT] = undefined;
    try {
      openConnection(() => undefined);
    } catch (error) {
      caught = error;
    }
    assertEquals((caught as ConnectionError).code, "not_configured");
    // With a URL and no backend: Deno.SQL when this runtime has it, else `unsupported`.
    try {
      const conn = openConnection(() => "postgres://u:pw@127.0.0.1:1/d");
      assertEquals(conn.source, "env");
      conn.close().catch(() => {});
    } catch (error) {
      assertEquals((error as ConnectionError).code, "unsupported");
    }
  } finally {
    holder[SLOT] = before;
  }
});

Deno.test("guardedClient: a bare query and a script each run in a timed transaction", async () => {
  const { sql, sent } = fakeClient([]);
  const guarded = guardedClient(sql, { readOnly: false, timeoutMs: 1234 });
  await guarded.unsafe("SELECT 1");
  await guarded.unsafe("SELECT 2; SELECT 3").simple!();
  await guarded`SELECT ${4}`;
  await guarded.begin(async (tx) => await tx.unsafe("SELECT 5"));
  await guarded.close();
  for (const text of ["SELECT 1", "SELECT 2; SELECT 3", "SELECT ?", "SELECT 5"]) {
    const s = sent.find((x) => x.text === text)!;
    assertEquals(sent.filter((x) => x.tx === s.tx)[0].text, "SET LOCAL statement_timeout = 1234");
  }
});

// ── storage ────────────────────────────────────────────────────────────────

const STORAGE = Symbol.for("denext.backend.storage");

/** Install a fake storage with one bucket holding two objects. */
function installStorage(): { removed: string[]; restore: () => void } {
  const holder = globalThis as { [STORAGE]?: unknown };
  const before = holder[STORAGE];
  const removed: string[] = [];
  const objects = new Map([
    ["a.txt", { key: "a.txt", size: 3, contentType: "text/plain", lastModified: new Date(0) }],
    ["big.bin", { key: "big.bin", size: 11 * 1024 * 1024, contentType: "application/x" }],
  ]);
  holder[STORAGE] = {
    driver: {
      name: "fake",
      head: (_b: string, key: string) => Promise.resolve(objects.get(key) ?? null),
      get: (_b: string, key: string) =>
        Promise.resolve(
          objects.has(key)
            ? { ...objects.get(key)!, body: ReadableStream.from([new TextEncoder().encode("abc")]) }
            : null,
        ),
      remove: (_b: string, key: string) => {
        removed.push(key);
        return Promise.resolve();
      },
      list: (_b: string, prefix: string, options: { cursor?: string }) =>
        Promise.resolve({
          objects: [...objects.values()].filter((o) => o.key.startsWith(prefix)),
          ...(options.cursor ? {} : { cursor: "next" }),
        }),
    },
    buckets: new Map([["files", { name: "files", maxBytes: 1024, mime: ["text/plain"] }]]),
  };
  return { removed, restore: () => void (holder[STORAGE] = before) };
}

Deno.test("storage: buckets, a page of objects, a download and a delete", async () => {
  const { removed, restore } = installStorage();
  try {
    const { sql, sent } = fakeClient([]);
    const buckets = await ask(sql, { op: "buckets" });
    assert(buckets.ok && "buckets" in buckets);
    assertEquals(buckets.driver, "fake");
    assertEquals(buckets.buckets, [{
      name: "files",
      public: false,
      maxBytes: 1024,
      mime: ["text/plain"],
    }]);
    const objects = await ask(sql, { op: "objects", bucket: "files", prefix: "a" });
    assert(objects.ok && "objects" in objects);
    assertEquals(objects.objects, [{
      key: "a.txt",
      size: 3,
      contentType: "text/plain",
      lastModified: "1970-01-01T00:00:00.000Z",
    }]);
    assertEquals(objects.cursor, "next");
    const file = await ask(sql, { op: "download", bucket: "files", key: "a.txt" });
    assert(file.ok && "base64" in file);
    assertEquals(atob(file.base64), "abc");
    const big = await ask(sql, { op: "download", bucket: "files", key: "big.bin" });
    assertEquals((big as DbFailure).code, "bad_request");
    const preview = await ask(sql, {
      op: "removeObject",
      bucket: "files",
      key: "a.txt",
      confirm: false,
    });
    assert(preview.ok && "applied" in preview && !preview.applied);
    assertEquals(removed, []);
    await ask(sql, { op: "removeObject", bucket: "files", key: "a.txt", confirm: true });
    assertEquals(removed, ["a.txt"]);
    const unknown = await ask(sql, { op: "objects", bucket: "../etc" });
    assertEquals((unknown as DbFailure).code, "not_found");
    const badKey = await ask(sql, { op: "download", bucket: "files", key: "a\0b" });
    assertEquals((badKey as DbFailure).code, "bad_request");
    assertEquals(sent.length, 0, "storage needs no database");
  } finally {
    restore();
  }
});

Deno.test("storage: a project without storage says so", async () => {
  const { sql } = fakeClient([]);
  const reply = await ask(sql, { op: "buckets" });
  assert(reply.ok && "buckets" in reply);
  assertEquals(reply.driver, null);
  assertEquals(((await ask(sql, { op: "objects", bucket: "x" })) as DbFailure).code, "not_found");
});
