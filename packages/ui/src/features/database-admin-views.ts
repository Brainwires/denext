// The Database section's administration views (`database.ts` serves them): the SQL editor, one
// user's page (ban, unban, a new password, revoke, delete), creating a user, and uploading an
// object. Plain server-rendered forms like the rest of the section, so they work with
// JavaScript disabled. A form that carries a password posts it once and runs: a preview would
// have to render it back into the page, and nothing secret is ever rendered.

import {
  Badge,
  CsrfField,
  DB_BAN_DURATIONS,
  DB_MAX_PASSWORD,
  DB_MIN_PASSWORD,
  DB_SQL_MAX_CHARS,
  DB_SQL_MAX_ROWS,
  DB_UPLOAD_MAX_BYTES,
  type DbAuthUser,
  type DbSqlResult,
  Fragment,
  h,
  Hidden,
  Input,
  Mono,
  Note,
  OpForm,
  Table,
  type VNode,
} from "@denext/denext/internal/ui-host";
import type { ViewCtx } from "./database-views.ts";

/** One `<select>` of fixed options — the schema-driven choice, never a free-text box. */
export function Choice(
  { name, label, options, value, id }: {
    readonly name: string;
    readonly label: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly value: string;
    readonly id?: string;
  },
): VNode {
  return h(
    "select",
    { name, id, "aria-label": id ? undefined : label },
    options.map((o) =>
      h("option", { key: o.value, value: o.value, selected: o.value === value }, o.label)
    ),
  );
}

// ── SQL editor ─────────────────────────────────────────────────────────────

/** The editor's two modes. */
const SQL_MODES = [
  { value: "read", label: "Read-only (one statement, READ ONLY)" },
  { value: "write", label: "Read-write (a script that commits)" },
];

/** A result grid: the columns, then the rows (`NULL` as a muted badge). */
function ResultGrid({ result }: { readonly result: DbSqlResult }): VNode {
  if (result.columns.length === 0) {
    return h(Note, null, `No rows (${result.ms} ms).`);
  }
  const rows = result.cells.map((row, index) =>
    h(
      "tr",
      { key: index },
      row.map((value, column) =>
        h("td", { key: column }, value === null ? h(Badge, { tone: "info" }, "NULL") : value)
      ),
    )
  );
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      `${result.rowCount} row(s) in ${result.ms} ms`,
      result.truncated ? ` — the first ${DB_SQL_MAX_ROWS} are shown` : "",
      ".",
    ),
    h("div", { class: "table-scroll" }, h(Table, { head: result.columns, rows })),
  );
}

/**
 * The SQL editor: the statement, the transaction to run it in, and (after a run) its rows.
 *
 * @param props `text` and `mode`: what was last run; `result`: its rows.
 * @returns The view.
 */
export function SqlView(
  { ctx, text, mode, result }: {
    readonly ctx: ViewCtx;
    readonly text: string;
    readonly mode: "read" | "write";
    readonly result?: DbSqlResult;
  },
): VNode {
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "Runs as the connecting role, with a statement timeout. Read-only runs one statement in a ",
      h(Mono, null, "READ ONLY"),
      " transaction; read-write runs a script and commits it. Row-level security does not apply to this role.",
    ),
    h(
      "form",
      { method: "post", action: "/database/sql", class: "sql-editor" },
      h(CsrfField, { csrf: ctx.csrf }),
      h(
        "div",
        { class: "field" },
        h("label", { for: "sql-text" }, "SQL"),
        h("textarea", {
          id: "sql-text",
          name: "sql",
          rows: "10",
          maxlength: String(DB_SQL_MAX_CHARS),
          spellcheck: "false",
          required: true,
        }, text),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "sql-mode" }, "Transaction"),
        " ",
        h(Choice, {
          name: "mode",
          label: "Transaction",
          options: SQL_MODES,
          value: mode,
          id: "sql-mode",
        }),
      ),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Run"),
    ),
    result ? h(ResultGrid, { result }) : null,
  );
}

// ── Users ──────────────────────────────────────────────────────────────────

/** A password field (never pre-filled). */
function PasswordField({ id, label }: { readonly id: string; readonly label: string }): VNode {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    h("input", {
      type: "password",
      id,
      name: "password",
      autocomplete: "new-password",
      minlength: String(DB_MIN_PASSWORD),
      maxlength: String(DB_MAX_PASSWORD),
    }),
  );
}

/** The form that creates a user (it runs on submit: it may carry a password). */
export function CreateUserForm({ ctx }: { readonly ctx: ViewCtx }): VNode {
  return h(
    "details",
    null,
    h("summary", null, "Create a user"),
    h(
      "form",
      { method: "post", action: "/database/users/create" },
      h(CsrfField, { csrf: ctx.csrf }),
      h(
        "div",
        { class: "field" },
        h("label", { for: "new-email" }, "Email"),
        h("input", {
          type: "email",
          id: "new-email",
          name: "email",
          required: true,
          autocomplete: "off",
        }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "new-name" }, "Name (optional)"),
        h("input", { type: "text", id: "new-name", name: "name", maxlength: "200" }),
      ),
      h(PasswordField, {
        id: "new-password",
        label: "Password (optional: without one, they sign in another way)",
      }),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          null,
          h(Input, { type: "checkbox", name: "verified", value: "1" }),
          " Email verified",
        ),
      ),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Create user"),
    ),
  );
}

/** Epoch seconds as an ISO timestamp, or `""`. */
function when(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? "" : new Date(seconds * 1000).toISOString();
}

/** Whether a ban is in force now. */
function banned(user: DbAuthUser): boolean {
  return typeof user.bannedUntil === "number" && user.bannedUntil > Date.now() / 1000;
}

/** One user's actions: each a form; the two-step ones preview first. */
function UserActions({ ctx, user }: { readonly ctx: ViewCtx; readonly user: DbAuthUser }): VNode {
  const preview = (action: string, label: string, extra?: VNode) =>
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/database/users",
      label,
      fields: { op: "preview", action, id: user.id },
      className: "op",
      extra,
      disabled: ctx.readOnly,
    });
  const durations = DB_BAN_DURATIONS.map((d) => ({ value: String(d.seconds), label: d.label }));
  return h(
    Fragment,
    null,
    h("h2", null, "Sign-in"),
    banned(user) ? preview("unban", "Unban…") : preview(
      "ban",
      "Ban…",
      h(Choice, {
        name: "seconds",
        label: "Ban length",
        options: durations,
        value: durations[1].value,
      }),
    ),
    preview("revoke", "Revoke sessions…"),
    h("h2", null, "Password"),
    h(
      "form",
      { method: "post", action: "/database/users" },
      h(CsrfField, { csrf: ctx.csrf }),
      h(Hidden, { name: "action", value: "password" }),
      h(Hidden, { name: "id", value: user.id }),
      h(PasswordField, { id: "reset-password", label: "New password" }),
      h(
        "p",
        { class: "field-help" },
        "Sets it at once and ends every session of this user. It is hashed before it is stored.",
      ),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Set password"),
    ),
    h("h2", null, "Danger zone"),
    preview("delete", "Delete user…"),
  );
}

/**
 * One user's page: who they are, and every action on them.
 *
 * @param props `user`: the user, or `null` when there is none.
 * @returns The view.
 */
export function UserView(
  { ctx, user }: { readonly ctx: ViewCtx; readonly user: DbAuthUser | null },
): VNode {
  const back = h("p", { class: "lead" }, h("a", { href: "/database/users" }, "« Users"));
  if (!user) return h(Fragment, null, back, h(Note, null, "No such user."));
  const facts: [string, string | VNode][] = [
    ["Id", h(Mono, null, user.id)],
    ["Email", user.email ?? ""],
    ["Name", user.name ?? ""],
    ["Created", when(user.createdAt)],
    ["Live sessions", String(user.sessions)],
    ["Second factor", user.mfa ? "confirmed" : "none"],
    ["Passkeys", String(user.passkeys)],
    [
      "Banned",
      banned(user) ? h(Badge, { tone: "warn" }, `until ${when(user.bannedUntil)}`) : "no",
    ],
  ];
  return h(
    Fragment,
    null,
    back,
    h(
      "dl",
      { class: "status" },
      facts.map(([label, value]) =>
        h(Fragment, { key: label }, h("dt", null, label), h("dd", null, value))
      ),
    ),
    h(UserActions, { ctx, user }),
  );
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Upload one object into a bucket (it runs on submit; an existing key is refused unless
 * "Replace" is ticked).
 *
 * @param props `bucket`; `prefix`: the key prefix being listed, offered as the key's start.
 * @returns The form.
 */
export function UploadForm(
  { ctx, bucket, prefix }: {
    readonly ctx: ViewCtx;
    readonly bucket: string;
    readonly prefix: string;
  },
): VNode {
  return h(
    "details",
    null,
    h("summary", null, "Upload an object"),
    h(
      "form",
      {
        method: "post",
        action: "/database/storage/upload",
        enctype: "multipart/form-data",
      },
      h(CsrfField, { csrf: ctx.csrf }),
      h(Hidden, { name: "bucket", value: bucket }),
      h(
        "div",
        { class: "field" },
        h("label", { for: "upload-file" }, "File"),
        h("input", { type: "file", id: "upload-file", name: "file", required: true }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "upload-key" }, "Key (the file's name is appended when it ends in /)"),
        h("input", {
          type: "text",
          id: "upload-key",
          name: "key",
          value: prefix,
          maxlength: "1024",
        }),
      ),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          null,
          h(Input, { type: "checkbox", name: "upsert", value: "1" }),
          " Replace an object already at that key",
        ),
      ),
      h(
        "p",
        { class: "field-help" },
        `At most ${
          DB_UPLOAD_MAX_BYTES / (1024 * 1024)
        } MiB here. The bucket's own size cap and type list apply.`,
      ),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Upload"),
    ),
  );
}
