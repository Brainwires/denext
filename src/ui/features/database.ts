// `/database` — the project's Postgres, its storage buckets and its auth users, from `denext ui`.
//
// Shown for a project that uses Postgres (`DATABASE_URL` is `postgres://`, or the config declares
// `postgres:`). Nothing here opens the database: every request becomes one JSON envelope
// (`../database/protocol.ts`) written to a `denext db-admin` child, which loads the project — its
// `.env`, its `backend({ postgres, storage })` — runs the one operation and prints the answer.
// That keeps the UI's rule: project code (a config, a custom `sql` client, a storage driver)
// never runs in this process.
//
// Every write is two POSTs. The first (`op=preview`) asks the child to BUILD the statement and
// return it unrun; the page shows that exact SQL and its parameters with a form carrying the same
// fields and `op=apply`. The second runs it — the child rebuilds it from the same fields, so what
// runs is what was shown — and answers `303` to a GET page, so a reload never runs it twice.
// `--read-only` is refused by the server before any of this (a POST is a mutation), and the child
// refuses writes on its own as well, running every read `READ ONLY`.
//
// Identifiers are never interpolated from a request: the child looks the table up in the
// catalog and quotes only names found there (`../database/sql.ts`). Values are `$n` parameters.

import { join, relative } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { migrationPlan } from "../../build/generate-ops.ts";
import { jsonResponse, type UiContext, type UiHandler } from "../html.ts";
import { FileDetails, Mono, Note, Out } from "../components.ts";
import { OFFLINE_STATUS } from "../offline.ts";
import { uiSafeUnder } from "../security.ts";
import { DB_UPLOAD_MAX_BYTES, type DbActor, type DbUserAction } from "../database/protocol.ts";
import { enableRlsMigration } from "../database/sql.ts";
import {
  type BrowseState,
  BucketsView,
  ConfirmView,
  Failure,
  href,
  MigrationsView,
  ObjectsView,
  OverviewView,
  PendingSql,
  PoliciesView,
  RowsView,
  RowView,
  StatementBlock,
  TableView,
  UsersView,
} from "./database-views.ts";
import { CreateUserForm, SqlView, UploadForm, UserView } from "./database-admin-views.ts";
import { logsPanel } from "./logs.ts";
import { presencePage, realtimePage, realtimeWrite } from "./realtime.ts";
import { functionsPage } from "./functions.ts";
import { healthPanel } from "./health.ts";
import {
  answer,
  applying,
  ask,
  carried,
  failure,
  FAILURE_STATUS,
  field,
  page,
  prefixed,
  seeOther,
  viewCtx,
} from "./database-kit.ts";

export { type DbChildRunner, setDbChildRunner } from "./database-kit.ts";

/** Why `--offline` refuses the section: a database is a network connection. */
const OFFLINE_DATABASE = "The database is unavailable — the UI runs --offline, and " +
  "reaching a database (even one on this machine) is a network connection.";

/** What a finished write reports on the page it lands on (`?done=`). */
const DONE: Record<string, string> = {
  updated: "Updated the row.",
  inserted: "Inserted the row.",
  deleted: "Deleted the row.",
  migrated: "Applied the pending migrations.",
  written: "Wrote the migration — review it, add its policies, then apply it here.",
  removed: "Deleted the object.",
  revoked: "Revoked the user's sessions.",
  "user-deleted": "Deleted the user.",
  "user-created": "Created the user.",
  banned: "Banned the user and ended every session.",
  unbanned: "Lifted the ban.",
  password: "Set the password and ended every session.",
  uploaded: "Uploaded the object.",
};

/** The `?done=` note, when a write just landed here. */
function doneNote(ctx: UiContext): VNode | null {
  const text = DONE[ctx.url.searchParams.get("done") ?? ""];
  return text ? h(Note, { tone: "ok" }, text) : null;
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** `GET /database`: the connection and the tables. */
async function overviewPage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"overview">(ctx, { op: "overview" });
  return answer(ctx, "/database", reply, (ok) => h(OverviewView, { reply: ok }));
}

/** `GET /database/table`: one table's structure. */
async function tablePage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"table">(ctx, {
    op: "table",
    schema: field(ctx, "schema"),
    table: field(ctx, "table"),
  });
  return answer(ctx, "/database", reply, (ok) => h(TableView, { table: ok.table }));
}

/** The actor `?as=` / `?uid=` / `?email=` asks for (the service role by default). */
function actorOf(ctx: UiContext): DbActor {
  const as = field(ctx, "as");
  const uid = field(ctx, "uid").trim();
  if (as === "anon") return { kind: "anon" };
  if (as === "user" && uid) {
    const email = field(ctx, "email").trim();
    return { kind: "user", id: uid, ...(email ? { email } : {}) };
  }
  return { kind: "service" };
}

/** The browse state the query asks for. */
function browseState(ctx: UiContext): BrowseState {
  const column = field(ctx, "fcol");
  return {
    sort: field(ctx, "sort") || undefined,
    direction: field(ctx, "dir") === "desc" ? "desc" : "asc",
    filterColumn: column || undefined,
    filterValue: column ? field(ctx, "fval") : undefined,
    filterNull: column !== "" && field(ctx, "fnull") === "1",
    actor: actorOf(ctx),
  };
}

/** The `?after=` cursor (a JSON array), or `undefined`. */
function cursorOf(ctx: UiContext): (string | null)[] | undefined {
  const raw = field(ctx, "after");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `GET /database/rows`: one page of rows. */
async function rowsPage(ctx: UiContext): Promise<Response> {
  const state = browseState(ctx);
  const after = cursorOf(ctx);
  const reply = await ask<"rows">(ctx, {
    op: "rows",
    schema: field(ctx, "schema"),
    table: field(ctx, "table"),
    ...(state.sort ? { sort: state.sort } : {}),
    direction: state.direction,
    ...(after ? { after } : {}),
    ...(state.filterColumn
      ? {
        filter: {
          column: state.filterColumn,
          value: state.filterNull ? null : state.filterValue ?? "",
        },
      }
      : {}),
    actor: state.actor,
  });
  return answer(ctx, "/database", reply, (ok) =>
    h(
      "div",
      null,
      doneNote(ctx),
      h(RowsView, { ctx: viewCtx(ctx), reply: ok, state, first: after === undefined }),
    ));
}

/** `GET /database/row`: one row, by its key (`k.<column>`). */
async function rowPage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"row">(ctx, {
    op: "row",
    schema: field(ctx, "schema"),
    table: field(ctx, "table"),
    key: prefixed(ctx, "k."),
  });
  return answer(
    ctx,
    "/database",
    reply,
    (ok) => h("div", null, doneNote(ctx), h(RowView, { ctx: viewCtx(ctx), reply: ok })),
  );
}

/** The values a write posts: `v.<column>` (with `n.<column>` for NULL), or one `column`. */
function writeValues(ctx: UiContext, action: string): Record<string, string | null> {
  if (action === "update") {
    const column = field(ctx, "column");
    return column ? { [column]: field(ctx, "null") === "1" ? null : field(ctx, "value") } : {};
  }
  const values: Record<string, string | null> = {};
  const nulls = prefixed(ctx, "n.");
  for (const [name, value] of Object.entries(prefixed(ctx, "v."))) {
    if (nulls[name] === "1") values[name] = null;
    else if (value !== "") values[name] = value;
  }
  for (const name of Object.keys(nulls)) if (nulls[name] === "1") values[name] = null;
  return values;
}

/** Where a row write lands (`done` set once it ran), or where its Cancel goes (`done` unset). */
function afterWrite(ctx: UiContext, action: string, done?: string): string {
  const table = { schema: field(ctx, "schema"), table: field(ctx, "table") };
  if (action === "update") {
    const key = Object.fromEntries(
      Object.entries(prefixed(ctx, "k.")).map(([k, v]) => [`k.${k}`, v]),
    );
    return href("/database/row", { ...table, ...key, done });
  }
  return href("/database/rows", { ...table, done });
}

/** The `?done=` code a row write reports. */
const ROW_DONE: Record<string, string> = {
  update: "updated",
  insert: "inserted",
  delete: "deleted",
};

/** `POST /database/rows`: preview or run an update, insert or delete. */
async function rowWrite(ctx: UiContext): Promise<Response> {
  const action = field(ctx, "action");
  if (action !== "update" && action !== "insert" && action !== "delete") {
    return answer(ctx, "/database", failure("bad_request", "unknown write"), () => h("div", null));
  }
  const apply = applying(ctx);
  const key = prefixed(ctx, "k.");
  const reply = await ask<"write">(ctx, {
    op: "write",
    action,
    schema: field(ctx, "schema"),
    table: field(ctx, "table"),
    ...(action === "insert" ? {} : { key }),
    values: writeValues(ctx, action),
    confirm: apply,
  });
  if (apply && reply.ok && !ctx.json) return seeOther(afterWrite(ctx, action, ROW_DONE[action]));
  const cancel = afterWrite(ctx, action === "update" ? "update" : "rows");
  return answer(ctx, "/database", reply, (ok) =>
    h(ConfirmView, {
      ctx: viewCtx(ctx),
      what: `Run this ${action.toUpperCase()}?`,
      body: h(StatementBlock, { statement: ok.statement }),
      action: "/database/rows",
      fields: carried(ctx),
      cancel,
      label: `Run ${action}`,
    }));
}

// ── Policies ───────────────────────────────────────────────────────────────

/** `GET /database/policies`. */
async function policiesPage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"policies">(ctx, { op: "policies" });
  return answer(
    ctx,
    "/database/policies",
    reply,
    (ok) => h(PoliciesView, { ctx: viewCtx(ctx), reply: ok }),
  );
}

/** The dashboard's answer to a write into the project (it owns no project files). */
function noProjectWrites(ctx: UiContext): Response {
  const reason = "the dashboard does not write project files: add the migration in the project";
  return answer(ctx, "/database/policies", failure("unsupported", reason), () => h("div", null));
}

/** A file name slug from a table name. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) ||
    "table";
}

/**
 * `POST /database/policies`: write a migration enabling row-level security on one table. The
 * table must be one the catalog lists; the file comes from the same planner as `denext generate
 * migration`, with this SQL as its body, and is written only where that planner put it.
 */
async function enableRls(ctx: UiContext): Promise<Response> {
  const reply = await ask<"policies">(ctx, { op: "policies" });
  if (!reply.ok) return answer(ctx, "/database/policies", reply, () => h("div", null));
  const schema = field(ctx, "schema");
  const name = field(ctx, "table");
  const table = reply.tables.find((t) => t.schema === schema && t.name === name);
  if (!table) {
    return answer(
      ctx,
      "/database/policies",
      failure("not_found", `no table ${schema}.${name}`),
      () => h("div", null),
    );
  }
  let plan;
  try {
    plan = await migrationPlan(ctx.dir, `enable_rls_${slug(table.schema)}_${slug(table.name)}`);
    for (const file of plan) await uiSafeUnder(ctx.dir, file.path);
  } catch (error) {
    return answer(
      ctx,
      "/database/policies",
      failure("bad_request", (error as Error).message),
      () => h("div", null),
    );
  }
  const files = plan.map((file, index) =>
    index === 0 ? { ...file, contents: enableRlsMigration(table) } : file
  );
  if (applying(ctx)) {
    for (const file of files) {
      await Deno.mkdir(join(file.path, ".."), { recursive: true });
      await Deno.writeTextFile(file.path, file.contents, { createNew: !file.overwrite });
    }
    const written = files.map((f) => relative(ctx.dir, f.path));
    return ctx.json
      ? jsonResponse({ ok: true, written })
      : seeOther("/database/migrations?done=written");
  }
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      preview: files.map((f) => ({ path: relative(ctx.dir, f.path), contents: f.contents })),
    });
  }
  return page(
    ctx,
    "/database/policies",
    h(ConfirmView, {
      ctx: viewCtx(ctx),
      what: `Enable row-level security on ${table.schema}.${table.name}?`,
      body: files.map((f) =>
        h(FileDetails, {
          key: f.path,
          path: relative(ctx.dir, f.path),
          badge: "would be written",
          open: true,
        }, h(Out, null, f.contents))
      ),
      action: "/database/policies",
      fields: { schema: table.schema, table: table.name },
      cancel: "/database/policies",
      label: "Write migration",
    }),
  );
}

// ── Migrations ─────────────────────────────────────────────────────────────

/** `GET /database/migrations`. */
async function migrationsPage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"migrations">(ctx, { op: "migrations" });
  return answer(
    ctx,
    "/database/migrations",
    reply,
    (ok) => h("div", null, doneNote(ctx), h(MigrationsView, { ctx: viewCtx(ctx), reply: ok })),
  );
}

/** `POST /database/migrations`: preview (a dry run) or apply the pending migrations. */
async function migrateWrite(ctx: UiContext): Promise<Response> {
  const apply = applying(ctx);
  const reply = await ask<"migrate">(ctx, { op: "migrate", confirm: apply });
  if (apply && reply.ok && !ctx.json) return seeOther("/database/migrations?done=migrated");
  return answer(
    ctx,
    "/database/migrations",
    reply,
    (ok) =>
      ok.pending.length === 0 ? h(Note, null, "Nothing is pending.") : h(ConfirmView, {
        ctx: viewCtx(ctx),
        what: `Apply ${ok.pending.length} pending migration(s)?`,
        body: h(PendingSql, { files: ok.pendingSql }),
        action: "/database/migrations",
        fields: {},
        cancel: "/database/migrations",
        label: "Apply",
      }),
  );
}

// ── Storage ────────────────────────────────────────────────────────────────

/** `GET /database/storage`: the buckets, or one bucket's objects. */
async function storagePage(ctx: UiContext): Promise<Response> {
  const bucket = field(ctx, "bucket");
  if (!bucket) {
    const reply = await ask<"buckets">(ctx, { op: "buckets" });
    return answer(ctx, "/database/storage", reply, (ok) => h(BucketsView, { reply: ok }));
  }
  const prefix = field(ctx, "prefix");
  const cursor = field(ctx, "cursor");
  const reply = await ask<"objects">(ctx, {
    op: "objects",
    bucket,
    prefix,
    ...(cursor ? { cursor } : {}),
  });
  return answer(ctx, "/database/storage", reply, (ok) =>
    h(
      "div",
      null,
      doneNote(ctx),
      h(ObjectsView, { ctx: viewCtx(ctx), reply: ok, prefix, first: cursor === "" }),
      h(UploadForm, { ctx: viewCtx(ctx), bucket: ok.bucket, prefix }),
    ));
}

/** The key an upload lands at: the field, with the file's name appended to a `…/` (or empty). */
function uploadKey(key: string, file: File): string {
  const name = file.name.split(/[\\/]/).pop() || "upload";
  return key === "" || key.endsWith("/") ? `${key}${name}` : key;
}

/**
 * `POST /database/storage/upload`: one file into a bucket, through the plugin's own operations
 * (so the bucket's cap and type list apply). Runs on submit; an existing key is refused unless
 * `upsert` is ticked.
 */
async function uploadWrite(ctx: UiContext): Promise<Response> {
  const bucket = field(ctx, "bucket");
  const file = ctx.form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return answer(
      ctx,
      "/database/storage",
      failure("bad_request", "choose a file to upload"),
      () => h("div", null),
    );
  }
  if (file.size > DB_UPLOAD_MAX_BYTES) {
    return answer(
      ctx,
      "/database/storage",
      failure("bad_request", `the UI uploads at most ${DB_UPLOAD_MAX_BYTES} bytes`),
      () => h("div", null),
    );
  }
  const key = uploadKey(field(ctx, "key").trim(), file);
  const reply = await ask<"upload">(ctx, {
    op: "upload",
    bucket,
    key,
    base64: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    ...(file.type ? { contentType: file.type } : {}),
    upsert: field(ctx, "upsert") === "1",
  });
  if (reply.ok && !ctx.json) {
    return seeOther(href("/database/storage", { bucket, done: "uploaded" }));
  }
  return answer(
    ctx,
    "/database/storage",
    reply,
    (ok) => h(Note, { tone: "ok" }, `Uploaded ${ok.key}.`),
  );
}

/** `POST /database/storage`: preview or delete one object. */
async function storageWrite(ctx: UiContext): Promise<Response> {
  const bucket = field(ctx, "bucket");
  const key = field(ctx, "key");
  const apply = applying(ctx);
  const reply = await ask<"removeObject">(ctx, { op: "removeObject", bucket, key, confirm: apply });
  if (apply && reply.ok && !ctx.json) {
    return seeOther(href("/database/storage", { bucket, done: "removed" }));
  }
  return answer(ctx, "/database/storage", reply, (ok) =>
    h(ConfirmView, {
      ctx: viewCtx(ctx),
      what: "Delete this object?",
      body: h(
        "p",
        { class: "lead" },
        "Removes ",
        h(Mono, null, ok.key),
        " from bucket ",
        h(Mono, null, ok.bucket),
        " through the storage driver. It cannot be undone.",
      ),
      action: "/database/storage",
      fields: { bucket, key },
      cancel: href("/database/storage", { bucket }),
      label: "Delete object",
    }));
}

/**
 * `GET /database/storage/download`: one object, as an attachment. Always
 * `application/octet-stream` with `nosniff`: an object is untrusted bytes, and served with its own
 * type on the UI's origin an HTML or SVG file would run as the UI.
 */
async function download(ctx: UiContext): Promise<Response> {
  const reply = await ask<"download">(ctx, {
    op: "download",
    bucket: field(ctx, "bucket"),
    key: field(ctx, "key"),
  });
  if (!reply.ok || ctx.json) return answer(ctx, "/database/storage", reply, () => h("div", null));
  const name = (reply.key.split("/").pop() || "object").replace(/[^\w.\-]+/g, "_");
  return new Response(decodeBase64(reply.base64), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

// ── Users ──────────────────────────────────────────────────────────────────

/** `GET /database/users`. */
async function usersPage(ctx: UiContext): Promise<Response> {
  const after = field(ctx, "after");
  const query = field(ctx, "q").trim();
  const reply = await ask<"users">(ctx, {
    op: "users",
    ...(after ? { after } : {}),
    ...(query ? { query } : {}),
  });
  return answer(ctx, "/database/users", reply, (ok) =>
    h(
      "div",
      null,
      doneNote(ctx),
      h(UsersView, { ctx: viewCtx(ctx), reply: ok, query, first: after === "" }),
      ok.schema === null ? null : h(CreateUserForm, { ctx: viewCtx(ctx) }),
    ));
}

/** `GET /database/user`: one user, and every action on them. */
async function userPage(ctx: UiContext): Promise<Response> {
  const reply = await ask<"user">(ctx, { op: "user", id: field(ctx, "id") });
  return answer(
    ctx,
    "/database/users",
    reply,
    (ok) => h("div", null, doneNote(ctx), h(UserView, { ctx: viewCtx(ctx), user: ok.user })),
  );
}

/**
 * `POST /database/users/create`: create a user. Runs on submit — the form may carry a
 * password, which a preview would have to render back into the page.
 */
async function userCreate(ctx: UiContext): Promise<Response> {
  const password = field(ctx, "password");
  const name = field(ctx, "name").trim();
  const reply = await ask<"createUser">(ctx, {
    op: "createUser",
    email: field(ctx, "email"),
    ...(name ? { name } : {}),
    ...(password ? { password } : {}),
    verified: field(ctx, "verified") === "1",
  });
  if (reply.ok && !ctx.json) {
    return seeOther(href("/database/user", { id: reply.id, done: "user-created" }));
  }
  return answer(ctx, "/database/users", reply, () => h("div", null));
}

/** The user actions a form may post. */
const USER_ACTIONS: readonly DbUserAction[] = ["revoke", "delete", "ban", "unban", "password"];

/** What each user action's confirm page asks. */
const USER_CONFIRM: Record<DbUserAction, { what: (id: string) => string; label: string }> = {
  revoke: { what: (id) => `Revoke every session of ${id}?`, label: "Revoke sessions" },
  delete: { what: (id) => `Delete user ${id}?`, label: "Delete user" },
  ban: { what: (id) => `Ban ${id} and end every session?`, label: "Ban user" },
  unban: { what: (id) => `Lift the ban on ${id}?`, label: "Unban user" },
  password: { what: (id) => `Set the password of ${id}?`, label: "Set password" },
};

/** Where an applied user action lands. */
function afterUserAction(action: DbUserAction, id: string): string {
  if (action === "delete") return "/database/users?done=user-deleted";
  if (action === "revoke") return "/database/users?done=revoked";
  const done = action === "ban" ? "banned" : action === "unban" ? "unbanned" : "password";
  return href("/database/user", { id, done });
}

/**
 * `POST /database/users`: preview or run an action on one user — revoke their sessions, delete
 * them, ban or unban them. Setting a password runs at once: its preview would have to carry the
 * password back into the page.
 */
async function userWrite(ctx: UiContext): Promise<Response> {
  const posted = field(ctx, "action");
  const action = USER_ACTIONS.includes(posted as DbUserAction) ? posted as DbUserAction : "revoke";
  const id = field(ctx, "id");
  const password = action === "password";
  const apply = password || applying(ctx);
  const seconds = Number(field(ctx, "seconds"));
  const reply = await ask<"userAction">(ctx, {
    op: "userAction",
    action,
    id,
    ...(action === "ban" ? { seconds } : {}),
    ...(password ? { password: field(ctx, "password") } : {}),
    confirm: apply,
  });
  if (apply && reply.ok && !ctx.json) return seeOther(afterUserAction(action, id));
  const fields: Record<string, string> = { action, id };
  if (action === "ban") fields.seconds = String(seconds);
  return answer(ctx, "/database/users", reply, (ok) =>
    h(ConfirmView, {
      ctx: viewCtx(ctx),
      what: USER_CONFIRM[action].what(id),
      body: ok.statements.map((statement, index) => h(StatementBlock, { key: index, statement })),
      action: "/database/users",
      fields,
      cancel: href("/database/user", { id }),
      label: USER_CONFIRM[action].label,
    }));
}

// ── SQL ────────────────────────────────────────────────────────────────────

/** `GET /database/sql`: the editor. */
function sqlPage(ctx: UiContext): Promise<Response> {
  return Promise.resolve(
    page(ctx, "/database/sql", h(SqlView, { ctx: viewCtx(ctx), text: "", mode: "read" })),
  );
}

/**
 * `POST /database/sql`: run what was typed, and show its rows under the editor (the text kept).
 * A failure is shown the same way, with a 200 so the page keeps the editor: a statement that
 * fails is an answer, not a broken page.
 */
async function sqlRun(ctx: UiContext): Promise<Response> {
  const text = field(ctx, "sql");
  const mode = field(ctx, "mode") === "write" ? "write" : "read";
  const reply = await ask<"sql">(ctx, { op: "sql", text, mode });
  if (ctx.json) return jsonResponse(reply, reply.ok ? 200 : FAILURE_STATUS[reply.code] ?? 500);
  const view = h(SqlView, {
    ctx: viewCtx(ctx),
    text,
    mode,
    ...(reply.ok ? { result: reply } : {}),
  });
  return page(ctx, "/database/sql", reply.ok ? view : [h(Failure, { failure: reply }), view]);
}

// ── the route table ────────────────────────────────────────────────────────

/** One page of the section: its GET and (when it writes) its POST. */
interface DbRoute {
  readonly get: (ctx: UiContext) => Promise<Response>;
  readonly post?: (ctx: UiContext) => Promise<Response>;
}

/** Every page, by path. */
const PAGES: Record<string, DbRoute> = {
  "/database": { get: overviewPage },
  "/database/table": { get: tablePage },
  "/database/rows": { get: rowsPage, post: rowWrite },
  "/database/row": { get: rowPage },
  // The dashboard owns no project files, so it never writes a migration.
  "/database/policies": {
    get: policiesPage,
    post: (ctx) => ctx.dashboard === true ? Promise.resolve(noProjectWrites(ctx)) : enableRls(ctx),
  },
  "/database/migrations": { get: migrationsPage, post: migrateWrite },
  "/database/storage": { get: storagePage, post: storageWrite },
  "/database/storage/download": { get: download },
  "/database/storage/upload": { get: storagePage, post: uploadWrite },
  "/database/users": { get: usersPage, post: userWrite },
  "/database/users/create": { get: usersPage, post: userCreate },
  "/database/user": { get: userPage },
  "/database/sql": { get: sqlPage, post: sqlRun },
  "/database/logs": { get: (ctx) => logsPanel(ctx) },
  "/database/realtime": { get: realtimePage, post: realtimeWrite },
  "/database/realtime/presence": { get: presencePage },
  "/database/functions": { get: functionsPage },
  "/database/health": { get: healthPanel },
};

/** Pages that reach neither a database nor the network (`--offline` keeps them). */
const OFFLINE_PAGES = new Set(["/database/logs", "/database/functions", "/database/health"]);

/** The section's paths and the methods each answers — what `routes.ts` registers. */
export const DATABASE_PATHS: readonly { path: string; methods: readonly string[] }[] = Object
  .entries(PAGES)
  .map(([path, route]) => ({ path, methods: route.post ? ["GET", "POST"] : ["GET"] }));

/**
 * Serve the Database section: every page and its `/api` twin.
 */
export const databasePanel: UiHandler = (_request: Request, ctx: UiContext): Promise<Response> => {
  const path = ctx.json ? ctx.url.pathname.slice("/api".length) : ctx.url.pathname;
  const route = PAGES[path];
  if (!route) return Promise.resolve(jsonResponse({ ok: false, reason: "not found" }, 404));
  if (ctx.offline === true && !OFFLINE_PAGES.has(path)) {
    if (ctx.json) {
      return Promise.resolve(jsonResponse({ ok: false, reason: OFFLINE_DATABASE }, OFFLINE_STATUS));
    }
    return Promise.resolve(
      page(ctx, "/database", h(Note, { tone: "warn" }, OFFLINE_DATABASE), OFFLINE_STATUS),
    );
  }
  if (ctx.method === "POST" && route.post) return route.post(ctx);
  return route.get(ctx);
};
