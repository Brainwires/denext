// `denext ui` → Database, the administration pages — the SQL editor, creating a user, one user's
// page (ban, unban, a new password), and uploading an object — driven on loopback the way a
// browser with JavaScript disabled drives them, with the `db-admin` child answered in-process
// (every envelope recorded). Covers: what each form sends the child; that a form carrying a
// password runs on submit and the password is never rendered back (not in a confirm page, not in
// a redirect, not in a failure); that a ban previews first and carries its length into the
// confirm; that a result grid is escaped; that an upload lands at the prefix + the file's name
// and an oversized one is refused before the child runs; `--read-only`; the JSON twins.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Harness, postTo, stopUi, uiOn } from "./helpers/ui-panel.ts";
import { type DbChildRunner, setDbChildRunner } from "../src/ui/features/database.ts";
import type { DbEnvelope, DbReply } from "../src/ui/database/protocol.ts";
import { UI_CSRF_HEADER } from "../src/ui/security.ts";

const PG_PROJECT = { ".env": "DATABASE_URL=postgres://app:pw@127.0.0.1:5432/app\n" };

const SECRET = "a new passphrase 42";

const USER = {
  id: "u1",
  email: "a@b.c",
  name: null,
  roles: null,
  createdAt: 0,
  sessions: 1,
  mfa: false,
  passkeys: 0,
  bannedUntil: null,
};

/** The SQL editor's answer: rows with markup in them, or a syntax error for `boom`. */
function sqlAnswer(r: Record<string, unknown>): DbReply {
  if (r.text === "boom") {
    return { ok: false, code: "query_failed", reason: 'syntax error at or near "boom"' };
  }
  return {
    ok: true,
    mode: r.mode === "write" ? "write" : "read",
    columns: ["id", "html"],
    cells: [["1", "<script>alert(1)</script>"], ["2", null]],
    rowCount: 2,
    truncated: false,
    ms: 3,
  };
}

/** The child's answers, by operation. */
const ANSWERS: Record<string, (r: Record<string, unknown>) => DbReply> = {
  sql: sqlAnswer,
  users: () => ({ ok: true, schema: "public", users: [USER] }),
  user: (r) => ({ ok: true, schema: "public", user: r.id === "u1" ? USER : null }),
  createUser: (r) =>
    r.email === "taken@x.test"
      ? { ok: false, code: "bad_request", reason: "a user with that email already exists" }
      : { ok: true, id: "new-id", statements: [] },
  userAction: (r) => ({
    ok: true,
    statements: [{
      text: 'UPDATE "public"."auth_users" SET banned_until = … WHERE id = $1',
      params: ["u1", String(r.seconds ?? "")],
    }],
    applied: r.confirm === true,
  }),
  objects: () => ({ ok: true, bucket: "files", objects: [] }),
  upload: (r) => ({ ok: true, bucket: "files", key: String(r.key), size: 5 }),
};

/** The child's answer to one envelope. */
function answer(e: DbEnvelope): DbReply {
  const reply = ANSWERS[e.request.op];
  return reply
    ? reply(e.request as unknown as Record<string, unknown>)
    : { ok: false, code: "bad_request", reason: "unanswered" };
}

/** Run `fn` against a UI on a Postgres project with the recording runner. */
async function withUi(
  fn: (h: Harness, sent: DbEnvelope[]) => Promise<void>,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  const sent: DbEnvelope[] = [];
  const runner: DbChildRunner = (envelope) => {
    sent.push(envelope);
    return Promise.resolve(answer(envelope));
  };
  const previous = setDbChildRunner(runner);
  const h = await uiOn(PG_PROJECT, opts, "denext_ui_dbadmin_");
  try {
    await fn(h, sent);
  } finally {
    setDbChildRunner(previous);
    await stopUi(h);
  }
}

/** A page's markup. */
async function page(h: Harness, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${h.base}${path}`, { headers: h.headers });
  return { status: res.status, body: await res.text() };
}

Deno.test("SQL editor: a textarea and a fixed choice of transaction, results escaped", async () => {
  await withUi(async (h, sent) => {
    const { body } = await page(h, "/database/sql");
    assertStringIncludes(body, '<textarea id="sql-text" name="sql"');
    assertStringIncludes(body, '<select name="mode" id="sql-mode">');
    assertStringIncludes(body, 'href="/database/sql" aria-current="page"');
    const res = await postTo(h, { sql: "select * from t", mode: "write" }, "/database/sql");
    assertEquals(res.status, 200);
    const html = await res.text();
    assertEquals(sent.map((e) => e.request), [{
      op: "sql",
      text: "select * from t",
      mode: "write",
    }]);
    assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert(!html.includes("<script>alert(1)"), "a cell can never run");
    assertStringIncludes(html, ">NULL<");
    assertStringIncludes(html, "select * from t</textarea>", "the text is kept");
    assertStringIncludes(html, '<option value="write" selected="">');
    // Anything but `write` is a read.
    await (await postTo(h, { sql: "select 1", mode: "anything" }, "/database/sql")).body?.cancel();
    assertEquals((sent[1].request as { mode: string }).mode, "read");
  });
});

Deno.test("SQL editor: a failing statement keeps the editor; the JSON twin answers the result", async () => {
  await withUi(async (h) => {
    const res = await postTo(h, { sql: "boom" }, "/database/sql");
    const html = await res.text();
    assertEquals(res.status, 200);
    assertStringIncludes(html, "query_failed: syntax error at or near &quot;boom&quot;");
    assertStringIncludes(html, ">boom</textarea>");
    const api = await fetch(`${h.base}/api/database/sql`, {
      method: "POST",
      headers: {
        ...h.headers,
        origin: h.base,
        [UI_CSRF_HEADER]: h.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "select 1" }),
    });
    const json = await api.json();
    assertEquals([api.status, json.ok, json.columns], [200, true, ["id", "html"]]);
    const failed = await fetch(`${h.base}/api/database/sql`, {
      method: "POST",
      headers: {
        ...h.headers,
        origin: h.base,
        [UI_CSRF_HEADER]: h.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "boom" }),
    });
    assertEquals(failed.status, 502);
    await failed.body?.cancel();
  });
});

Deno.test("SQL editor: --read-only disables Run and the server refuses the post", async () => {
  await withUi(async (h, sent) => {
    const { body } = await page(h, "/database/sql");
    assertStringIncludes(body, '<button type="submit" disabled="">Run</button>');
    const res = await postTo(h, { sql: "select 1" }, "/database/sql");
    assertEquals(res.status, 403);
    await res.body?.cancel();
    assertEquals(sent, []);
  }, { readOnly: true });
});

Deno.test("users: create runs on submit; the password goes to the child and never comes back", async () => {
  await withUi(async (h, sent) => {
    const list = (await page(h, "/database/users")).body;
    assertStringIncludes(list, 'action="/database/users/create"');
    assertStringIncludes(list, 'type="password" id="new-password" name="password"');
    assertStringIncludes(list, 'href="/database/user?id=u1">Manage</a>');
    const res = await postTo(h, {
      email: "n@x.test",
      name: "N",
      password: SECRET,
      verified: "1",
    }, "/database/users/create");
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/database/user?id=new-id&done=user-created");
    assertEquals(sent.at(-1)?.request, {
      op: "createUser",
      email: "n@x.test",
      name: "N",
      password: SECRET,
      verified: true,
    });
    const taken = await postTo(
      h,
      { email: "taken@x.test", password: SECRET },
      "/database/users/create",
    );
    const html = await taken.text();
    assertEquals(taken.status, 400);
    assertStringIncludes(html, "already exists");
    assert(!html.includes(SECRET), "a failure never renders the password");
  });
});

Deno.test("one user: a ban previews with its length; a new password runs at once, unrendered", async () => {
  await withUi(async (h, sent) => {
    const { body } = await page(h, "/database/user?id=u1");
    assertStringIncludes(body, '<select name="seconds" aria-label="Ban length">');
    assertStringIncludes(body, '<option value="86400" selected="">24 hours</option>');
    assertStringIncludes(body, 'type="password" id="reset-password" name="password"');
    const preview = await postTo(
      h,
      { op: "preview", action: "ban", id: "u1", seconds: "86400" },
      "/database/users",
    );
    const confirm = await preview.text();
    assertEquals(preview.status, 200);
    assertStringIncludes(confirm, "Ban u1 and end every session?");
    assertStringIncludes(confirm, 'name="seconds" value="86400"');
    assertStringIncludes(confirm, 'name="op" value="apply"');
    assertEquals((sent.at(-1)?.request as { confirm: boolean }).confirm, false);
    const applied = await postTo(
      h,
      { op: "apply", action: "ban", id: "u1", seconds: "86400" },
      "/database/users",
    );
    assertEquals(applied.headers.get("location"), "/database/user?id=u1&done=banned");
    assertEquals(sent.at(-1)?.request, {
      op: "userAction",
      action: "ban",
      id: "u1",
      seconds: 86400,
      confirm: true,
    });
    // The password: one post, confirmed straight away (a preview would render it back).
    const reset = await postTo(
      h,
      { action: "password", id: "u1", password: SECRET },
      "/database/users",
    );
    assertEquals([reset.status, reset.headers.get("location")], [
      303,
      "/database/user?id=u1&done=password",
    ]);
    assertEquals(sent.at(-1)?.request, {
      op: "userAction",
      action: "password",
      id: "u1",
      password: SECRET,
      confirm: true,
    });
    const after = (await page(h, "/database/user?id=u1&done=password")).body;
    assertStringIncludes(after, "Set the password and ended every session.");
    assert(!after.includes(SECRET));
    const missing = (await page(h, "/database/user?id=nobody")).body;
    assertStringIncludes(missing, "No such user.");
  });
});

/** A multipart upload post. */
function upload(h: Harness, fields: Record<string, string>, file?: File): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", file);
  return fetch(`${h.base}/database/storage/upload`, {
    method: "POST",
    redirect: "manual",
    headers: { ...h.headers, origin: h.base, [UI_CSRF_HEADER]: h.csrf },
    body: form,
  });
}

Deno.test("storage: an upload lands at the prefix + the file's name; too big is refused first", async () => {
  await withUi(async (h, sent) => {
    const bucket = (await page(h, "/database/storage?bucket=files&prefix=docs%2F")).body;
    assertStringIncludes(bucket, 'enctype="multipart/form-data"');
    assertStringIncludes(bucket, 'name="key" value="docs/"');
    const res = await upload(
      h,
      { bucket: "files", key: "docs/", upsert: "1" },
      new File(["hello"], "../a b.txt", { type: "text/plain" }),
    );
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/database/storage?bucket=files&done=uploaded");
    assertEquals(sent.at(-1)?.request, {
      op: "upload",
      bucket: "files",
      key: "docs/a b.txt",
      base64: btoa("hello"),
      contentType: "text/plain",
      upsert: true,
    });
    const named = await upload(
      h,
      { bucket: "files", key: "exact.bin" },
      new File(["x"], "ignored"),
    );
    await named.body?.cancel();
    assertEquals((sent.at(-1)?.request as { key: string; upsert: boolean }).key, "exact.bin");
    const count = sent.length;
    const big = await upload(
      h,
      { bucket: "files", key: "" },
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big"),
    );
    assertEquals(big.status, 400);
    await big.body?.cancel();
    const none = await upload(h, { bucket: "files", key: "x" });
    assertEquals(none.status, 400);
    await none.body?.cancel();
    assertEquals(sent.length, count, "neither reached the child");
  });
});
