// `denext ui` → Database: the pages, driven on loopback the way a browser with JavaScript
// disabled drives them — links, GET forms and real form posts — with the `db-admin` child
// answered in-process through the panel's runner seam (every envelope recorded). Covers: the
// section appears only for a project that uses Postgres; every write is a preview first (the
// exact SQL, a form carrying the same fields with `op=apply`) and then a 303; `--read-only` and a
// missing CSRF token are refused by the server before any child runs; `--offline` refuses the
// section; a download is an attachment that can never render on the UI's origin; enabling RLS
// writes a migration (never runs SQL) and only for a table the catalog lists; the JSON twin.
// The last test runs the REAL child end to end on a project with no database.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { exists, type Harness, postTo, stopUi, uiOn } from "./helpers/ui-panel.ts";
import { type DbChildRunner, setDbChildRunner } from "../src/ui/features/database.ts";
import type { DbEnvelope, DbReplies, DbReply, DbTableInfo } from "../src/ui/database/protocol.ts";

/** A project that uses Postgres (the Database section applies). */
const PG_PROJECT = { ".env": "DATABASE_URL=postgres://app:pw@127.0.0.1:5432/app\n" };

const NOTES: DbTableInfo = {
  schema: "public",
  name: "notes",
  kind: "table",
  estimate: 2,
  rls: false,
  forced: false,
  hasPrimaryKey: true,
  columns: [
    {
      name: "id",
      type: "bigint",
      castType: "bigint",
      nullable: false,
      default: null,
      identity: "by default",
      generated: false,
    },
    {
      name: "title",
      type: "text",
      castType: "text",
      nullable: true,
      default: null,
      identity: null,
      generated: false,
    },
  ],
  primaryKey: ["id"],
  indexes: [],
  foreignKeys: [],
  policies: [],
};

/** Canned answers, by operation. */
const ANSWERS: { [K in keyof DbReplies]?: (e: DbEnvelope) => DbReplies[K] } = {
  overview: () => ({
    connection: "postgres://app:•••@127.0.0.1:5432/app",
    source: "env",
    storage: true,
    authSchema: "public",
    tables: [NOTES],
    truncated: false,
  }),
  table: () => ({ table: NOTES }),
  rows: () => ({
    table: NOTES,
    rows: [{ id: "1", title: "<script>alert(1)</script>" }, { id: "2", title: null }],
    next: ["2"],
    statement: { text: 'SELECT … FROM "public"."notes" ORDER BY "id" ASC LIMIT 51', params: [] },
  }),
  row: () => ({ table: NOTES, row: { id: "1", title: "hello" } }),
  write: (e) => ({
    statement: {
      text:
        'UPDATE "public"."notes" SET "title" = $1::text WHERE "id" = $2::bigint RETURNING "id"::text',
      params: ["new title", "1"],
    },
    applied: (e.request as { confirm: boolean }).confirm,
    affected: 1,
  }),
  policies: () => ({ tables: [NOTES], policies: [] }),
  migrations: () => ({
    dir: "migrations",
    migrations: [{ name: "001_a.sql", state: "pending" }],
    unknown: [],
    pendingSql: [{ name: "001_a.sql", sql: "CREATE TABLE a ();" }],
  }),
  migrate: (e) => ({
    pending: ["001_a.sql"],
    applied: (e.request as { confirm: boolean }).confirm ? ["001_a.sql"] : [],
    pendingSql: [{ name: "001_a.sql", sql: "CREATE TABLE a ();" }],
  }),
  buckets: () => ({
    driver: "fs",
    buckets: [{ name: "files", public: false, maxBytes: 1024, mime: null }],
  }),
  objects: () => ({ bucket: "files", objects: [{ key: "a/x.html", size: 5 }] }),
  download: () => ({
    key: "a/x.html",
    contentType: "text/html",
    size: 22,
    base64: btoa("<script>evil()</script>"),
  }),
  removeObject: (e) => ({
    bucket: "files",
    key: "a/x.html",
    applied: (e.request as { confirm: boolean }).confirm,
  }),
  users: () => ({
    schema: "public",
    users: [{
      id: "u1",
      email: "a@b.c",
      name: null,
      roles: null,
      createdAt: 0,
      sessions: 2,
      mfa: true,
      passkeys: 0,
    }],
  }),
  userAction: (e) => ({
    statements: [{
      text: 'DELETE FROM "public"."auth_sessions" WHERE user_id = $1',
      params: ["u1"],
    }],
    applied: (e.request as { confirm: boolean }).confirm,
  }),
};

/** Install a recording runner answering from {@linkcode ANSWERS}. */
function record(override?: (e: DbEnvelope) => DbReply | undefined): {
  sent: DbEnvelope[];
  restore: () => void;
} {
  const sent: DbEnvelope[] = [];
  const runner: DbChildRunner = (envelope) => {
    sent.push(envelope);
    const custom = override?.(envelope);
    if (custom) return Promise.resolve(custom);
    const answer = ANSWERS[envelope.request.op] as ((e: DbEnvelope) => object) | undefined;
    return Promise.resolve(
      answer
        ? { ok: true, ...answer(envelope) } as DbReply
        : { ok: false, code: "bad_request", reason: "unanswered" },
    );
  };
  const previous = setDbChildRunner(runner);
  return { sent, restore: () => void setDbChildRunner(previous) };
}

/** A page's markup, as a no-JS browser reads it. */
async function get(h: Harness, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${h.base}${path}`, { headers: h.headers });
  return { status: res.status, body: await res.text() };
}

/** Run `fn` against a UI on a Postgres project with the recording runner. */
async function withUi(
  fn: (h: Harness, sent: DbEnvelope[]) => Promise<void>,
  opts: { readOnly?: boolean; offline?: boolean } = {},
  files: Record<string, string> = PG_PROJECT,
  override?: (e: DbEnvelope) => DbReply | undefined,
): Promise<void> {
  const { sent, restore } = record(override);
  const h = await uiOn(files, opts, "denext_ui_db_");
  try {
    await fn(h, sent);
  } finally {
    restore();
    await stopUi(h);
  }
}

Deno.test("the Database entry is in the navigation only for a project that uses Postgres", async () => {
  await withUi(async (h) => {
    assertStringIncludes((await get(h, "/")).body, 'href="/database"');
  });
  await withUi(
    async (h) => {
      const home = (await get(h, "/")).body;
      assertEquals(home.includes('href="/database"'), false);
      // Opened directly, the page still answers (and says what the child said).
      assertEquals((await get(h, "/database")).status, 200);
    },
    {},
    { "deno.json": "{}\n" },
  );
  await withUi(
    async (h) => {
      assertStringIncludes((await get(h, "/")).body, 'href="/database"');
    },
    {},
    { "denext.config.ts": "export default { plugins: [backend({ postgres: {} })] };\n" },
  );
});

Deno.test("Tables: the connection (masked), every table and its links, no JS needed", async () => {
  await withUi(async (h, sent) => {
    const { status, body } = await get(h, "/database");
    assertEquals(status, 200);
    assertStringIncludes(body, "postgres://app:•••@127.0.0.1:5432/app");
    assertEquals(body.includes(":pw@"), false);
    assertStringIncludes(body, 'href="/database/table?schema=public&amp;table=notes"');
    assertStringIncludes(body, 'href="/database/rows?schema=public&amp;table=notes"');
    assertStringIncludes(body, "no RLS");
    assertEquals(sent[0], { readOnly: false, request: { op: "overview" } });
    const table = await get(h, "/database/table?schema=public&table=notes");
    assertStringIncludes(table.body, "Columns");
    assertEquals(sent[1].request, { op: "table", schema: "public", table: "notes" });
  });
});

Deno.test("Rows: escaped cells, sort links, keyset next page, filter and 'as user' as GET forms", async () => {
  await withUi(async (h, sent) => {
    const { body } = await get(
      h,
      "/database/rows?schema=public&table=notes&sort=title&dir=desc&fcol=title&fval=x&as=user&uid=u1&email=a%40b.c",
    );
    assertEquals(body.includes("<script>alert(1)</script>"), false);
    assertStringIncludes(body, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assertStringIncludes(body, "Previewing as user u1");
    assertStringIncludes(body, 'action="/database/rows" class="filter"');
    assertStringIncludes(body, "after=%5B%222%22%5D");
    assertEquals(sent[0].request, {
      op: "rows",
      schema: "public",
      table: "notes",
      sort: "title",
      direction: "desc",
      filter: { column: "title", value: "x" },
      actor: { kind: "user", id: "u1", email: "a@b.c" },
    });
    await get(h, '/database/rows?schema=public&table=notes&fcol=title&fnull=1&after=["2"]');
    assertEquals(sent[1].request, {
      op: "rows",
      schema: "public",
      table: "notes",
      direction: "asc",
      after: ["2"],
      filter: { column: "title", value: null },
      actor: { kind: "service" },
    });
    // The service role is the default, and labelled as bypassing row-level security.
    assertStringIncludes(
      (await get(h, "/database/rows?schema=public&table=notes")).body,
      "service role",
    );
  });
});

Deno.test("a cell edit previews the exact SQL, then applies the same fields and redirects", async () => {
  await withUi(async (h, sent) => {
    const row = await get(h, "/database/row?schema=public&table=notes&k.id=1");
    assertStringIncludes(row.body, 'name="k.id" value="1"');
    assertStringIncludes(row.body, "Preview update");
    const fields = {
      action: "update",
      op: "preview",
      schema: "public",
      table: "notes",
      column: "title",
      "k.id": "1",
      value: "new title",
    };
    const preview = await postTo(h, fields, "/database/rows");
    const page = await preview.text();
    assertEquals(preview.status, 200);
    assertStringIncludes(page, "UPDATE &quot;public&quot;.&quot;notes&quot;");
    assertStringIncludes(page, "new title");
    assertStringIncludes(page, 'name="op" value="apply"');
    assertStringIncludes(page, 'name="column" value="title"');
    const previewed = sent[sent.length - 1].request;
    assertEquals(previewed, {
      op: "write",
      action: "update",
      schema: "public",
      table: "notes",
      key: { id: "1" },
      values: { title: "new title" },
      confirm: false,
    });
    const apply = await postTo(h, { ...fields, op: "apply" }, "/database/rows");
    assertEquals(apply.status, 303);
    assertEquals(
      apply.headers.get("location"),
      "/database/row?schema=public&table=notes&k.id=1&done=updated",
    );
    assertEquals(sent[sent.length - 1].request as unknown, { ...previewed, confirm: true });
    assertStringIncludes(
      (await get(h, "/database/row?schema=public&table=notes&k.id=1&done=updated")).body,
      "Updated the row.",
    );
  });
});

Deno.test("a value cut by the row view is shown cut and not offered for editing", async () => {
  await withUi(
    async (h) => {
      const body = (await get(h, "/database/row?schema=public&table=notes&k.id=1")).body;
      assertStringIncludes(body, "Too long to edit here.");
      assertEquals(body.includes('aria-label="New title"'), false);
      assertStringIncludes(body, 'aria-label="New id"', "the short key value is still editable");
    },
    {},
    PG_PROJECT,
    (e) =>
      e.request.op === "row"
        ? { ok: true, table: NOTES, row: { id: "1", title: "y".repeat(65_537) } }
        : undefined,
  );
});

Deno.test("insert and delete post their values and key; NULL is its own checkbox", async () => {
  await withUi(async (h, sent) => {
    await postTo(h, {
      action: "insert",
      op: "preview",
      schema: "public",
      table: "notes",
      "v.title": "",
      "n.title": "1",
      "v.id": "",
    }, "/database/rows");
    assertEquals(sent[0].request, {
      op: "write",
      action: "insert",
      schema: "public",
      table: "notes",
      values: { title: null },
      confirm: false,
    });
    const del = await postTo(h, {
      action: "delete",
      op: "apply",
      schema: "public",
      table: "notes",
      "k.id": "2",
    }, "/database/rows");
    assertEquals(del.status, 303);
    assertEquals(
      del.headers.get("location"),
      "/database/rows?schema=public&table=notes&done=deleted",
    );
    assertEquals((sent[1].request as { key: unknown }).key, { id: "2" });
    const bad = await postTo(
      h,
      { action: "truncate", schema: "public", table: "notes" },
      "/database/rows",
    );
    assertEquals(bad.status, 400);
    assertEquals(sent.length, 2);
  });
});

/** Every write the section accepts, as a no-JS form would post it. */
const WRITES: [string, Record<string, string>][] = [
  ["/database/rows", {
    action: "delete",
    op: "apply",
    schema: "public",
    table: "notes",
    "k.id": "1",
  }],
  ["/database/policies", { op: "apply", schema: "public", table: "notes" }],
  ["/database/migrations", { op: "apply" }],
  ["/database/storage", { op: "apply", bucket: "files", key: "a" }],
  ["/database/users", { op: "apply", action: "delete", id: "u1" }],
];

Deno.test("--read-only refuses every write on the server; reads still work, read-only", async () => {
  await withUi(async (h, sent) => {
    for (const [path, fields] of WRITES) {
      const res = await postTo(h, { ...fields, op: "preview" }, path);
      assertEquals(res.status, 403, path);
      assertEquals((await res.json()).reason, "read-only");
      const run = await postTo(h, fields, path);
      assertEquals(run.status, 403, path);
      await run.body?.cancel();
    }
    assertEquals(sent.length, 0, "no child ran for a refused write");
    const page = (await get(h, "/database/row?schema=public&table=notes&k.id=1")).body;
    assertStringIncludes(page, "Read-only mode");
    assertStringIncludes(page, "disabled");
    assertEquals(sent[0].readOnly, true, "and the child is told, so it refuses writes too");
    assertEquals(await exists(join(h.dir, "migrations")), false);
  }, { readOnly: true });
});

Deno.test("a write without the CSRF token, or cross-origin, never reaches the child", async () => {
  await withUi(async (h, sent) => {
    for (const [path, fields] of WRITES) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const noToken = await fetch(`${h.base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { ...h.headers, origin: h.base },
        body: form,
      });
      assertEquals(noToken.status, 403, path);
      await noToken.body?.cancel();
      const crossSite = await fetch(`${h.base}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { ...h.headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: form,
      });
      assertEquals(crossSite.status, 403, path);
      await crossSite.body?.cancel();
    }
    assertEquals(sent.length, 0);
  });
});

Deno.test("--offline refuses the section: a database is a network connection", async () => {
  await withUi(async (h, sent) => {
    const page = await get(h, "/database");
    assertEquals(page.status, 503);
    assertStringIncludes(page.body, "--offline");
    const api = await fetch(`${h.base}/api/database/users`, { headers: h.headers });
    assertEquals(api.status, 503);
    await api.body?.cancel();
    assertEquals(sent.length, 0);
  }, { offline: true });
});

Deno.test("a download is an octet-stream attachment with nosniff, whatever the object says", async () => {
  await withUi(async (h, sent) => {
    const res = await fetch(`${h.base}/database/storage/download?bucket=files&key=a%2Fx.html`, {
      headers: h.headers,
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/octet-stream");
    assertEquals(res.headers.get("content-disposition"), 'attachment; filename="x.html"');
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assertEquals(await res.text(), "<script>evil()</script>");
    assertEquals(sent[0].request, { op: "download", bucket: "files", key: "a/x.html" });
    const objects = (await get(h, "/database/storage?bucket=files")).body;
    assertStringIncludes(objects, 'download=""');
    assertStringIncludes((await get(h, "/database/storage")).body, "files");
  });
});

Deno.test("storage delete, users revoke/delete and migrations each preview, then 303", async () => {
  await withUi(async (h, sent) => {
    const cases: [string, Record<string, string>, string, string][] = [
      [
        "/database/storage",
        { bucket: "files", key: "a/x.html" },
        "Delete this object?",
        "/database/storage?bucket=files&done=removed",
      ],
      [
        "/database/users",
        { action: "revoke", id: "u1" },
        "auth_sessions",
        "/database/users?done=revoked",
      ],
      [
        "/database/users",
        { action: "delete", id: "u1" },
        "Delete user u1?",
        "/database/users?done=user-deleted",
      ],
      ["/database/migrations", {}, "CREATE TABLE a ();", "/database/migrations?done=migrated"],
    ];
    for (const [path, fields, shown, location] of cases) {
      const preview = await postTo(h, { ...fields, op: "preview" }, path);
      assertStringIncludes(await preview.text(), shown, path);
      assertEquals((sent[sent.length - 1].request as { confirm: boolean }).confirm, false);
      const apply = await postTo(h, { ...fields, op: "apply" }, path);
      assertEquals(apply.status, 303, path);
      assertEquals(apply.headers.get("location"), location);
      assertEquals((sent[sent.length - 1].request as { confirm: boolean }).confirm, true);
    }
    for (const path of ["/database/users", "/database/migrations", "/database/policies"]) {
      assertEquals((await get(h, path)).status, 200, path);
    }
  });
});

Deno.test("enabling RLS writes a migration for a catalog table, and runs no SQL", async () => {
  await withUi(async (h, sent) => {
    const preview = await postTo(
      h,
      { op: "preview", schema: "public", table: "notes" },
      "/database/policies",
    );
    const page = await preview.text();
    assertStringIncludes(
      page,
      "ALTER TABLE &quot;public&quot;.&quot;notes&quot; ENABLE ROW LEVEL SECURITY;",
    );
    assertEquals(await exists(join(h.dir, "migrations")), false, "a preview writes nothing");
    const apply = await postTo(
      h,
      { op: "apply", schema: "public", table: "notes" },
      "/database/policies",
    );
    assertEquals(apply.status, 303);
    assertEquals(apply.headers.get("location"), "/database/migrations?done=written");
    const files = [...Deno.readDirSync(join(h.dir, "migrations"))].map((e) => e.name);
    assertEquals(files.length, 1);
    assert(files[0].endsWith("_enable_rls_public_notes.sql"), files[0]);
    assertStringIncludes(
      await Deno.readTextFile(join(h.dir, "migrations", files[0])),
      'ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;',
    );
    assert(await exists(join(h.dir, "jobs", "migrate.ts")), "the runner comes with it");
    assertEquals(sent.every((e) => e.request.op === "policies"), true, "only the catalog was read");
    const unknown = await postTo(
      h,
      { op: "apply", schema: "public", table: "nope; DROP" },
      "/database/policies",
    );
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
  });
});

Deno.test("the JSON twin answers with the child's reply and a status per failure", async () => {
  await withUi(
    async (h) => {
      const ok = await (await fetch(`${h.base}/api/database`, { headers: h.headers })).json();
      assertEquals(ok.ok, true);
      assertEquals(ok.tables[0].name, "notes");
      const res = await fetch(`${h.base}/api/database/users`, { headers: h.headers });
      assertEquals(res.status, 409);
      assertEquals((await res.json()).code, "not_configured");
      // An HTML page shows the failure as a note (200, so ui.js swaps it in).
      const page = await get(h, "/database/users");
      assertEquals(page.status, 200);
      assertStringIncludes(page.body, "not_configured: nothing here");
    },
    {},
    PG_PROJECT,
    (e) =>
      e.request.op === "users"
        ? { ok: false, code: "not_configured", reason: "nothing here" }
        : undefined,
  );
});

Deno.test("the real db-admin child answers a project without a database", async () => {
  const h = await uiOn({ "deno.json": "{}\n" }, {}, "denext_ui_db_real_");
  try {
    const res = await fetch(`${h.base}/api/database`, { headers: h.headers });
    const reply = await res.json();
    assertEquals(reply.ok, false);
    assertEquals(reply.code, "not_configured", JSON.stringify(reply));
    assertEquals(res.status, 409);
  } finally {
    await stopUi(h);
  }
});
