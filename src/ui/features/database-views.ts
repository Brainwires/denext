// The views of `denext ui`'s Database section (`database.ts` serves them). Plain server-rendered
// markup like every other panel: links and `<form>`s, so it all works with JavaScript disabled —
// sorting is a link, a filter is a GET form, and every write is a POST that first answers with a
// confirm page showing the exact statement it will run.

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import {
  Badge,
  CsrfField,
  Hidden,
  Input,
  Mono,
  Note,
  OpForm,
  Out,
  Panel,
  Table,
  Tabs,
} from "../components.ts";
import {
  DB_CELL_MAX_CHARS,
  DB_CELL_PREVIEW_CHARS,
  type DbActor,
  type DbAuthUser,
  type DbColumn,
  type DbFailure,
  type DbObject,
  type DbPolicy,
  type DbReplies,
  type DbStatement,
  type DbTableInfo,
  type DbTableSummary,
} from "../database/protocol.ts";

/** The section's tabs. */
const DATABASE_TABS = [
  { href: "/database", label: "Tables" },
  { href: "/database/sql", label: "SQL" },
  { href: "/database/policies", label: "Policies" },
  { href: "/database/migrations", label: "Migrations" },
  { href: "/database/storage", label: "Storage" },
  { href: "/database/users", label: "Users" },
  { href: "/database/realtime", label: "Realtime" },
  { href: "/database/functions", label: "Functions" },
  { href: "/database/logs", label: "Logs" },
  { href: "/database/health", label: "Health" },
];

/** What every view is told about the request. */
export interface ViewCtx {
  /** The session CSRF token. */
  readonly csrf: string;
  /** `--read-only`: every write control is disabled. */
  readonly readOnly: boolean;
  /**
   * Served as the stack's dashboard: nothing writes project files (enabling RLS writes a
   * migration into the project, which a dashboard's container does not own).
   */
  readonly dashboard?: boolean;
}

/**
 * The section's panel: its tabs, a lead, then the view. The dashboard's sidebar already lists
 * the same pages, so it shows no tab strip.
 */
export function DbPanel(
  { tab, title, children, dashboard }: {
    readonly tab: string;
    readonly title?: string;
    readonly children?: VNodeChildren;
    readonly dashboard?: boolean;
  },
): VNode {
  return h(
    Panel,
    { name: "Database", title: title ?? "Database" },
    dashboard ? null : h(Tabs, { items: DATABASE_TABS, active: tab, label: "Database views" }),
    children,
  );
}

/** The read-only note, when the UI runs `--read-only`. */
export function readOnlyNote(ctx: ViewCtx): VNodeChild {
  return ctx.readOnly
    ? h(Note, { tone: "warn" }, "Read-only mode — every write is refused.")
    : null;
}

/** A failed request, explained. */
export function Failure({ failure }: { readonly failure: DbFailure }): VNode {
  return h(
    Fragment,
    null,
    h(Note, { role: "alert" }, `${failure.code}: ${failure.reason}`),
    failure.sql ? h(Out, null, failure.sql) : null,
  );
}

/** A URL with query parameters (empty values left out). */
export function href(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** The query parameters naming a table. */
function tableParams(table: { schema: string; name: string }): Record<string, string> {
  return { schema: table.schema, table: table.name };
}

/** The query parameters naming one row: the table, then `k.<column>` per key column. */
function rowParams(
  table: DbTableInfo,
  row: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = tableParams(table);
  for (const name of table.primaryKey) out[`k.${name}`] = row[name] ?? "";
  return out;
}

/** A value cut to `max` characters, with a marker when it was cut. */
function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** A cell: `NULL` as a muted badge, else the (cut) text. */
function cell(value: string | null | undefined, max = DB_CELL_PREVIEW_CHARS): VNodeChild {
  return value === null || value === undefined
    ? h(Badge, { tone: "info" }, "NULL")
    : cut(value, max);
}

/** A wide table, scrollable on its own instead of widening the page. */
function Scroll({ children }: { readonly children?: VNodeChildren }): VNode {
  return h("div", { class: "table-scroll" }, children);
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** A table's name as a cell linking to its structure. */
function TableCell({ table }: { readonly table: DbTableSummary }): VNode {
  return h(
    "td",
    null,
    h("a", { href: href("/database/table", tableParams(table)) }, `${table.schema}.${table.name}`),
  );
}

/** A table's kind, row estimate and RLS state as badges. */
function TableBadges({ table }: { readonly table: DbTableSummary }): VNode {
  return h(
    Fragment,
    null,
    table.rls
      ? h(Badge, { tone: "ok" }, table.forced ? "RLS forced" : "RLS")
      : table.kind === "table" || table.kind === "partitioned"
      ? h(Badge, { tone: "warn" }, "no RLS")
      : null,
    table.hasPrimaryKey ? null : h(Badge, { tone: "info" }, "no primary key"),
  );
}

/** The overview: the connection, then every table. */
export function OverviewView(
  { reply }: { readonly reply: DbReplies["overview"] },
): VNode {
  const rows = reply.tables.map((t) =>
    h(
      "tr",
      { key: `${t.schema}.${t.name}` },
      h(TableCell, { table: t }),
      h("td", null, t.kind),
      h("td", null, t.estimate === null ? "—" : `≈ ${t.estimate}`),
      h("td", null, h(TableBadges, { table: t })),
      h("td", null, h("a", { href: href("/database/rows", tableParams(t)) }, "Browse")),
    )
  );
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "Connected to ",
      h(Mono, null, reply.connection),
      reply.source === "backend" ? " through backend({ postgres })." : " from DATABASE_URL.",
      " Every query runs in its own transaction with a statement timeout. ",
      h("a", { href: "https://denext.dev/docs/ui#database" }, "Database ↗"),
    ),
    reply.tables.length === 0
      ? h(Note, null, "This database has no tables yet.")
      : h(Scroll, null, h(Table, { head: ["Table", "Kind", "Rows", "", ""], rows })),
    reply.truncated ? h(Note, null, "Only the first 1000 tables are listed.") : null,
  );
}

/** One column's facts. */
function columnFacts(column: DbColumn): string {
  const facts = [
    column.nullable ? "nullable" : "not null",
    column.identity ? `identity (${column.identity})` : "",
    column.generated ? "generated" : "",
  ];
  return facts.filter(Boolean).join(", ");
}

/** A table's structure: columns, keys, indexes, foreign keys and policies. */
export function TableView({ table }: { readonly table: DbTableInfo }): VNode {
  const columns = table.columns.map((c) =>
    h(
      "tr",
      { key: c.name },
      h("td", null, h(Mono, null, c.name), table.primaryKey.includes(c.name) ? " 🔑" : ""),
      h("td", null, h(Mono, null, c.type)),
      h("td", null, columnFacts(c)),
      h("td", null, c.default === null ? "" : h(Mono, null, c.default)),
    )
  );
  const named = (items: readonly { name: string; definition: string }[]) =>
    items.map((i) =>
      h("tr", { key: i.name }, h("td", null, i.name), h("td", null, h(Mono, null, i.definition)))
    );
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      h(Mono, null, `${table.schema}.${table.name}`),
      ` — ${table.kind}. `,
      h(TableBadges, { table }),
      " ",
      h("a", { href: href("/database/rows", tableParams(table)) }, "Browse rows"),
    ),
    h("h2", null, "Columns"),
    h(Scroll, null, h(Table, { head: ["Column", "Type", "", "Default"], rows: columns })),
    h("h2", null, "Indexes"),
    table.indexes.length
      ? h(Scroll, null, h(Table, { head: ["Name", "Definition"], rows: named(table.indexes) }))
      : h(Note, null, "None."),
    h("h2", null, "Foreign keys"),
    table.foreignKeys.length
      ? h(Scroll, null, h(Table, { head: ["Name", "Definition"], rows: named(table.foreignKeys) }))
      : h(Note, null, "None."),
    h("h2", null, "Policies"),
    h(PolicyTable, { policies: table.policies }),
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────

/** What the row browser was asked for, echoed into its links and forms. */
export interface BrowseState {
  readonly sort?: string;
  readonly direction: "asc" | "desc";
  readonly filterColumn?: string;
  readonly filterValue?: string;
  readonly filterNull: boolean;
  readonly actor: DbActor;
}

/** The query parameters carrying the browse state (minus the cursor). */
function browseParams(table: DbTableInfo, state: BrowseState): Record<string, string | undefined> {
  return {
    ...tableParams(table),
    sort: state.sort,
    dir: state.direction === "desc" ? "desc" : undefined,
    fcol: state.filterColumn,
    fval: state.filterValue,
    fnull: state.filterNull ? "1" : undefined,
    as: state.actor.kind === "service" ? undefined : state.actor.kind,
    uid: state.actor.kind === "user" ? state.actor.id : undefined,
    email: state.actor.kind === "user" ? state.actor.email : undefined,
  };
}

/** Who the page is read as, said plainly. */
function ActorNote({ actor }: { readonly actor: DbActor }): VNode {
  if (actor.kind === "service") {
    return h(
      Note,
      { tone: "warn" },
      h(Badge, { tone: "warn" }, "service role"),
      " Reading as the connecting role: row-level security does not apply, so every row shows.",
    );
  }
  const who = actor.kind === "anon" ? "anon (signed out)" : `user ${actor.id}`;
  return h(
    Note,
    { tone: "ok" },
    h(Badge, { tone: "info" }, "as user"),
    ` Previewing as ${who}: row-level security decides which rows show.`,
  );
}

/** The "as user" toggle: a GET form. */
function ActorForm(
  { table, state }: { readonly table: DbTableInfo; readonly state: BrowseState },
): VNode {
  const keep = browseParams(table, state);
  const hidden = ["schema", "table", "sort", "dir", "fcol", "fval", "fnull"]
    .filter((k) => keep[k] !== undefined)
    .map((k) => h(Hidden, { key: k, name: k, value: keep[k] as string }));
  const option = (value: string, label: string) =>
    h("option", { key: value, value, selected: state.actor.kind === value }, label);
  return h(
    "form",
    { method: "get", action: "/database/rows", class: "filter" },
    hidden,
    h(
      "select",
      { name: "as", "aria-label": "Read rows as" },
      option("service", "Service role (bypasses RLS)"),
      option("anon", "anon (signed out)"),
      option("user", "A user (by id)"),
    ),
    h(Input, {
      name: "uid",
      value: state.actor.kind === "user" ? state.actor.id : "",
      placeholder: "user id (auth.uid())",
      ariaLabel: "User id",
    }),
    h(Input, {
      name: "email",
      value: state.actor.kind === "user" ? state.actor.email ?? "" : "",
      placeholder: "email (optional)",
      ariaLabel: "User email",
    }),
    h("button", { type: "submit" }, "Read as"),
  );
}

/** The `column = value` filter: a GET form. */
function FilterRowForm(
  { table, state }: { readonly table: DbTableInfo; readonly state: BrowseState },
): VNode {
  const keep = browseParams(table, state);
  const hidden = ["schema", "table", "sort", "dir", "as", "uid", "email"]
    .filter((k) => keep[k] !== undefined)
    .map((k) => h(Hidden, { key: k, name: k, value: keep[k] as string }));
  return h(
    "form",
    { method: "get", action: "/database/rows", class: "filter", role: "search" },
    hidden,
    h(
      "select",
      { name: "fcol", "aria-label": "Filter column" },
      h("option", { value: "" }, "Filter: column…"),
      table.columns.map((c) =>
        h("option", { key: c.name, value: c.name, selected: c.name === state.filterColumn }, c.name)
      ),
    ),
    h(Input, {
      name: "fval",
      value: state.filterValue ?? "",
      placeholder: "= value",
      ariaLabel: "Value",
    }),
    h(
      "label",
      null,
      h(Input, { type: "checkbox", name: "fnull", value: "1", checked: state.filterNull }),
      " is NULL",
    ),
    h("button", { type: "submit" }, "Filter"),
    state.filterColumn
      ? h(
        "a",
        {
          class: "lead",
          href: href("/database/rows", {
            ...keep,
            fcol: undefined,
            fval: undefined,
            fnull: undefined,
          }),
        },
        "Clear",
      )
      : null,
  );
}

/** A column header: a link that sorts by it (again: flips the direction). */
function SortHeader(
  { table, state, column }: {
    readonly table: DbTableInfo;
    readonly state: BrowseState;
    readonly column: string;
  },
): VNode {
  const current = state.sort === column;
  const direction = current && state.direction === "asc" ? "desc" : "asc";
  const marker = current ? (state.direction === "asc" ? " ▲" : " ▼") : "";
  return h(
    "a",
    {
      href: href("/database/rows", {
        ...browseParams(table, state),
        sort: column,
        dir: direction === "desc" ? "desc" : undefined,
      }),
    },
    column + marker,
  );
}

/** The page of rows. */
function RowsTable(
  { reply, state }: { readonly reply: DbReplies["rows"]; readonly state: BrowseState },
): VNode {
  const table = reply.table;
  const keyed = table.primaryKey.length > 0;
  const head = table.columns.map((c) =>
    h("th", { key: c.name }, h(SortHeader, { table, state, column: c.name }))
  );
  const rows = reply.rows.map((row, index) =>
    h(
      "tr",
      { key: index },
      h(
        "td",
        null,
        keyed ? h("a", { href: href("/database/row", rowParams(table, row)) }, "Open") : "",
      ),
      table.columns.map((c) => h("td", { key: c.name }, cell(row[c.name]))),
    )
  );
  return h(
    Scroll,
    null,
    h(
      "table",
      { class: "table" },
      h("thead", null, h("tr", null, h("th", null, ""), head)),
      h("tbody", null, rows),
    ),
  );
}

/** One field of the insert form. */
function InsertField({ column }: { readonly column: DbColumn }): VNode {
  const id = `ins-${column.name}`;
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, column.name, " ", h(Badge, null, column.type)),
    h("textarea", { id, name: `v.${column.name}`, rows: "1" }),
    h(
      "label",
      null,
      h(Input, { type: "checkbox", name: `n.${column.name}`, value: "1" }),
      " NULL",
    ),
  );
}

/** Insert a row: one field per settable column; an empty field takes the column's default. */
function InsertForm(
  { ctx, table }: { readonly ctx: ViewCtx; readonly table: DbTableInfo },
): VNode {
  const settable = table.columns.filter((c) => !c.generated && c.identity !== "always");
  return h(
    "details",
    null,
    h("summary", null, "Insert a row"),
    h(
      "form",
      { method: "post", action: "/database/rows" },
      h(CsrfField, { csrf: ctx.csrf }),
      h(Hidden, { name: "action", value: "insert" }),
      h(Hidden, { name: "op", value: "preview" }),
      h(Hidden, { name: "schema", value: table.schema }),
      h(Hidden, { name: "table", value: table.name }),
      h("p", { class: "lead" }, "An empty field is left out, so the column takes its default."),
      settable.map((c) => h(InsertField, { key: c.name, column: c })),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Preview insert"),
    ),
  );
}

/** The row browser. */
export function RowsView(
  { ctx, reply, state, first }: {
    readonly ctx: ViewCtx;
    readonly reply: DbReplies["rows"];
    readonly state: BrowseState;
    readonly first: boolean;
  },
): VNode {
  const table = reply.table;
  const params = browseParams(table, state);
  const writable = (table.kind === "table" || table.kind === "partitioned") &&
    table.primaryKey.length > 0;
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      h(Mono, null, `${table.schema}.${table.name}`),
      " · ",
      h("a", { href: href("/database/table", tableParams(table)) }, "Structure"),
      table.primaryKey.length
        ? ` · paged by ${table.primaryKey.join(", ")}`
        : " · no primary key: the first page only, read-only",
    ),
    h(ActorNote, { actor: state.actor }),
    h(ActorForm, { table, state }),
    h(FilterRowForm, { table, state }),
    reply.rows.length ? h(RowsTable, { reply, state }) : h(Note, null, "No rows."),
    h(
      "p",
      { class: "lead" },
      first ? null : h("a", { href: href("/database/rows", params) }, "« First page"),
      first || !reply.next ? null : " · ",
      reply.next
        ? h(
          "a",
          { href: href("/database/rows", { ...params, after: JSON.stringify(reply.next) }) },
          "Next page »",
        )
        : null,
    ),
    h(StatementDetails, { summary: "The query", statement: reply.statement }),
    writable ? h(InsertForm, { ctx, table }) : null,
  );
}

/** One editable value of the row view. */
function CellEditor(
  { ctx, table, row, column }: {
    readonly ctx: ViewCtx;
    readonly table: DbTableInfo;
    readonly row: Record<string, string | null>;
    readonly column: DbColumn;
  },
): VNode {
  const value = row[column.name];
  const tooLong = value !== null && value !== undefined && value.length > DB_CELL_MAX_CHARS;
  const editable = !column.generated && column.identity !== "always" && !tooLong;
  const keyFields = Object.fromEntries(
    table.primaryKey.map((name) => [`k.${name}`, row[name] ?? ""]),
  );
  const form = editable
    ? h(OpForm, {
      csrf: ctx.csrf,
      action: "/database/rows",
      label: "Preview update",
      fields: {
        action: "update",
        op: "preview",
        schema: table.schema,
        table: table.name,
        column: column.name,
        ...keyFields,
      },
      extra: [
        h(
          "textarea",
          { key: "v", name: "value", rows: "2", "aria-label": `New ${column.name}` },
          value ?? "",
        ),
        h(
          "label",
          { key: "n" },
          h(Input, { type: "checkbox", name: "null", value: "1", checked: value === null }),
          " NULL ",
        ),
      ],
      disabled: ctx.readOnly,
    })
    : h(Note, null, tooLong ? "Too long to edit here." : "Not editable (generated or identity).");
  return h(
    "div",
    { class: "field" },
    h(
      "p",
      { class: "group-summary" },
      h(Mono, null, column.name),
      " ",
      h(Badge, null, column.type),
    ),
    h(Out, null, value === null || value === undefined ? "NULL" : cut(value, DB_CELL_MAX_CHARS)),
    form,
  );
}

/** One row, every value editable. */
export function RowView(
  { ctx, reply }: { readonly ctx: ViewCtx; readonly reply: DbReplies["row"] },
): VNode {
  const { table, row } = reply;
  const back = h("a", { href: href("/database/rows", tableParams(table)) }, "« Rows");
  if (!row) {
    return h(Fragment, null, h("p", { class: "lead" }, back), h(Note, null, "No such row."));
  }
  const keyFields = Object.fromEntries(table.primaryKey.map((n) => [`k.${n}`, row[n] ?? ""]));
  const writable = table.kind === "table" || table.kind === "partitioned";
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      back,
      " · ",
      h(Mono, null, `${table.schema}.${table.name}`),
      " · ",
      table.primaryKey.map((n) => `${n} = ${row[n]}`).join(", "),
    ),
    table.columns.map((column) =>
      writable ? h(CellEditor, { key: column.name, ctx, table, row, column }) : h(
        "div",
        { key: column.name, class: "field" },
        h("p", { class: "group-summary" }, h(Mono, null, column.name)),
        h(Out, null, row[column.name] ?? "NULL"),
      )
    ),
    writable
      ? h(OpForm, {
        csrf: ctx.csrf,
        action: "/database/rows",
        label: "Preview delete",
        fields: {
          action: "delete",
          op: "preview",
          schema: table.schema,
          table: table.name,
          ...keyFields,
        },
        className: "op",
        disabled: ctx.readOnly,
      })
      : null,
  );
}

// ── the confirm step ───────────────────────────────────────────────────────

/** A statement and its parameters. */
export function StatementBlock({ statement }: { readonly statement: DbStatement }): VNode {
  const params = statement.params.map((value, index) =>
    h(
      "tr",
      { key: index },
      h("td", null, h(Mono, null, `$${index + 1}`)),
      h("td", null, cell(value, DB_CELL_MAX_CHARS)),
    )
  );
  return h(
    Fragment,
    null,
    h(Out, null, statement.text),
    params.length ? h(Table, { head: ["Parameter", "Value"], rows: params }) : null,
  );
}

/** A statement, collapsed. */
function StatementDetails(
  { summary, statement }: { readonly summary: string; readonly statement: DbStatement },
): VNode {
  return h("details", null, h("summary", null, summary), h(StatementBlock, { statement }));
}

/**
 * The confirm page every write goes through: what will run, and a form that runs exactly that.
 *
 * @param props `what`: the heading; `body`: the statements (or a description); `action` and
 *   `fields`: the form that applies it (the same fields, `op=apply`); `cancel`: where Cancel goes.
 */
export function ConfirmView(
  { ctx, what, body, action, fields, cancel, label }: {
    readonly ctx: ViewCtx;
    readonly what: string;
    readonly body: VNodeChildren;
    readonly action: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly cancel: string;
    readonly label: string;
  },
): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, what),
    h("p", { class: "lead" }, "Nothing has run yet — review exactly what will, then run it."),
    body,
    h(OpForm, {
      csrf: ctx.csrf,
      action,
      label,
      fields: { ...fields, op: "apply" },
      className: "op",
      disabled: ctx.readOnly,
    }),
    h("p", { class: "lead" }, h("a", { href: cancel }, "Cancel")),
  );
}

// ── Policies ───────────────────────────────────────────────────────────────

/** Policies as a table. */
function PolicyTable({ policies }: { readonly policies: readonly DbPolicy[] }): VNode {
  if (policies.length === 0) return h(Note, null, "No policies.");
  const rows = policies.map((p) =>
    h(
      "tr",
      { key: `${p.schema}.${p.table}.${p.name}` },
      h("td", null, `${p.schema}.${p.table}`),
      h("td", null, p.name),
      h("td", null, `${p.command} · ${p.permissive.toLowerCase()}`),
      h("td", null, h(Mono, null, p.roles)),
      h("td", null, p.using === null ? "" : h(Mono, null, p.using)),
      h("td", null, p.check === null ? "" : h(Mono, null, p.check)),
    )
  );
  return h(
    Scroll,
    null,
    h(Table, { head: ["Table", "Policy", "For", "Roles", "Using", "With check"], rows }),
  );
}

/** Row-level security: each table's state, and every policy. */
export function PoliciesView(
  { ctx, reply }: { readonly ctx: ViewCtx; readonly reply: DbReplies["policies"] },
): VNode {
  const counts = new Map<string, number>();
  for (const p of reply.policies) {
    const key = `${p.schema}.${p.table}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = reply.tables.map((t) =>
    h(
      "tr",
      { key: `${t.schema}.${t.name}` },
      h(TableCell, { table: t }),
      h("td", null, h(TableBadges, { table: t })),
      h("td", null, String(counts.get(`${t.schema}.${t.name}`) ?? 0)),
      h(
        "td",
        null,
        t.rls || ctx.dashboard ? "" : h(OpForm, {
          csrf: ctx.csrf,
          action: "/database/policies",
          label: "Enable RLS…",
          fields: { op: "preview", schema: t.schema, table: t.name },
          disabled: ctx.readOnly,
        }),
      ),
    )
  );
  return h(
    Fragment,
    null,
    ctx.dashboard
      ? h(
        "p",
        { class: "lead" },
        "Each table's row-level security and its policies. Change them with a migration in the project (",
        h(Mono, null, "migrations/"),
        "), applied from Migrations.",
      )
      : h(
        "p",
        { class: "lead" },
        "Enabling row-level security writes a migration (",
        h(Mono, null, "migrations/"),
        ") — review it, add your policies, and apply it from Migrations. Nothing is altered directly.",
      ),
    h("h2", null, "Tables"),
    h(Scroll, null, h(Table, { head: ["Table", "Row-level security", "Policies", ""], rows })),
    h("h2", null, "Policies"),
    h(PolicyTable, { policies: reply.policies }),
  );
}

// ── Migrations ─────────────────────────────────────────────────────────────

/** A migration state as a badge. */
function MigrationBadge({ state }: { readonly state: string }): VNode {
  const tone = state === "applied" ? "ok" : state === "pending" ? "todo" : "warn";
  return h(Badge, { tone }, state === "changed" ? "applied, then edited" : state);
}

/** The pending migrations' SQL. */
export function PendingSql(
  { files }: { readonly files: readonly { name: string; sql: string }[] },
): VNode {
  return h(
    Fragment,
    null,
    files.map((f) =>
      h(
        "details",
        { key: f.name, open: true },
        h("summary", null, h("code", null, f.name)),
        h(Out, null, f.sql),
      )
    ),
  );
}

/** Each migration's state, and the button that applies the pending ones. */
export function MigrationsView(
  { ctx, reply }: { readonly ctx: ViewCtx; readonly reply: DbReplies["migrations"] },
): VNode {
  const rows = reply.migrations.map((m) =>
    h(
      "tr",
      { key: m.name },
      h("td", null, h(Mono, null, m.name)),
      h("td", null, h(MigrationBadge, { state: m.state })),
      h("td", null, m.appliedAt ?? ""),
    )
  );
  const pending = reply.migrations.filter((m) => m.state === "pending").length;
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "The SQL files in ",
      h(Mono, null, `${reply.dir}/`),
      ", tracked in ",
      h(Mono, null, "_migrations"),
      " — what ",
      h(Mono, null, "denext job migrate"),
      " applies. Write one from Generate (migration).",
    ),
    reply.migrations.length
      ? h(Table, { head: ["Migration", "State", "Applied"], rows })
      : h(Note, null, `No migrations in ${reply.dir}/.`),
    reply.unknown.length
      ? h(
        Note,
        { tone: "warn" },
        `Recorded as applied but no longer on disk: ${reply.unknown.join(", ")}`,
      )
      : null,
    pending
      ? h(OpForm, {
        csrf: ctx.csrf,
        action: "/database/migrations",
        label: `Apply ${pending} pending…`,
        fields: { op: "preview" },
        className: "op",
        disabled: ctx.readOnly,
      })
      : null,
  );
}

// ── Storage ────────────────────────────────────────────────────────────────

/** The declared buckets. */
export function BucketsView({ reply }: { readonly reply: DbReplies["buckets"] }): VNode {
  if (reply.driver === null) {
    return h(Note, null, "This project declares no storage (backend({ storage })).");
  }
  const rows = reply.buckets.map((b) =>
    h(
      "tr",
      { key: b.name },
      h("td", null, h("a", { href: href("/database/storage", { bucket: b.name }) }, b.name)),
      h("td", null, b.public ? h(Badge, { tone: "warn" }, "public") : h(Badge, null, "private")),
      h("td", null, `${b.maxBytes} bytes`),
      h("td", null, b.mime ? b.mime.join(", ") : "any"),
    )
  );
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "Buckets declared in the config, on the ",
      h(Mono, null, reply.driver),
      " driver.",
    ),
    h(Table, { head: ["Bucket", "Access", "Largest object", "Types"], rows }),
  );
}

/** One page of a bucket's objects. */
export function ObjectsView(
  { ctx, reply, prefix, first }: {
    readonly ctx: ViewCtx;
    readonly reply: DbReplies["objects"];
    readonly prefix: string;
    readonly first: boolean;
  },
): VNode {
  const rows = reply.objects.map((o: DbObject) =>
    h(
      "tr",
      { key: o.key },
      h("td", null, h(Mono, null, o.key)),
      h("td", null, String(o.size)),
      h("td", null, o.contentType ?? "—"),
      h("td", null, o.lastModified ?? ""),
      h(
        "td",
        null,
        h("a", {
          href: href("/database/storage/download", { bucket: reply.bucket, key: o.key }),
          download: "",
        }, "Download"),
      ),
      h(
        "td",
        null,
        h(OpForm, {
          csrf: ctx.csrf,
          action: "/database/storage",
          label: "Delete…",
          fields: { op: "preview", bucket: reply.bucket, key: o.key },
          disabled: ctx.readOnly,
        }),
      ),
    )
  );
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      h("a", { href: "/database/storage" }, "« Buckets"),
      " · ",
      h(Mono, null, reply.bucket),
    ),
    h(
      "form",
      { method: "get", action: "/database/storage", class: "filter", role: "search" },
      h(Hidden, { name: "bucket", value: reply.bucket }),
      h(Input, {
        type: "search",
        name: "prefix",
        value: prefix,
        placeholder: "Key prefix",
        ariaLabel: "Key prefix",
      }),
      h("button", { type: "submit" }, "List"),
    ),
    rows.length
      ? h(Scroll, null, h(Table, { head: ["Key", "Bytes", "Type", "Modified", "", ""], rows }))
      : h(Note, null, "No objects."),
    h(
      "p",
      { class: "lead" },
      first ? null : h(
        "a",
        { href: href("/database/storage", { bucket: reply.bucket, prefix }) },
        "« First page",
      ),
      first || !reply.cursor ? null : " · ",
      reply.cursor
        ? h("a", {
          href: href("/database/storage", { bucket: reply.bucket, prefix, cursor: reply.cursor }),
        }, "Next page »")
        : null,
    ),
  );
}

// ── Users ──────────────────────────────────────────────────────────────────

/** Epoch seconds as an ISO date, or `""`. */
function date(seconds: number | null): string {
  return seconds === null ? "" : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** One user's row. */
function UserRow({ ctx, user }: { readonly ctx: ViewCtx; readonly user: DbAuthUser }): VNode {
  const action = (name: "revoke" | "delete", label: string) =>
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/database/users",
      label,
      fields: { op: "preview", action: name, id: user.id },
      disabled: ctx.readOnly,
    });
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, user.id)),
    h("td", null, user.email ?? ""),
    h("td", null, user.name ?? ""),
    h("td", null, String(user.sessions)),
    h(
      "td",
      null,
      user.mfa ? h(Badge, { tone: "ok" }, "MFA") : h(Badge, { tone: "info" }, "no MFA"),
    ),
    h("td", null, String(user.passkeys)),
    h("td", null, date(user.createdAt)),
    h(
      "td",
      null,
      typeof user.bannedUntil === "number" && user.bannedUntil > Date.now() / 1000
        ? h(Badge, { tone: "warn" }, "banned")
        : null,
    ),
    h("td", null, h("a", { href: href("/database/user", { id: user.id }) }, "Manage")),
    h("td", null, action("revoke", "Revoke sessions…")),
    h("td", null, action("delete", "Delete…")),
  );
}

/** The auth users. */
export function UsersView(
  { ctx, reply, query, first }: {
    readonly ctx: ViewCtx;
    readonly reply: DbReplies["users"];
    readonly query: string;
    readonly first: boolean;
  },
): VNode {
  if (reply.schema === null) {
    return h(
      Note,
      null,
      "No denext auth tables here (auth_users) — they appear once denextAuth runs with a Postgres adapter (backendAuthAdapter() or postgresAuthAdapter()).",
    );
  }
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "denext auth's users, from ",
      h(Mono, null, `${reply.schema}.auth_users`),
      ". Sessions counts the session store's live rows plus live native-app sessions; a stateless cookie session is not stored, so it cannot be counted or revoked here — it ends when it expires.",
    ),
    h(
      "form",
      { method: "get", action: "/database/users", class: "filter", role: "search" },
      h(Input, {
        type: "search",
        name: "q",
        value: query,
        placeholder: "Email or name contains",
        ariaLabel: "Search users",
      }),
      h("button", { type: "submit" }, "Search"),
    ),
    reply.users.length
      ? h(
        Scroll,
        null,
        h(Table, {
          head: [
            "Id",
            "Email",
            "Name",
            "Sessions",
            "Second factor",
            "Passkeys",
            "Created",
            "",
            "",
            "",
            "",
          ],
          rows: reply.users.map((u) => h(UserRow, { key: u.id, ctx, user: u })),
        }),
      )
      : h(Note, null, "No users."),
    h(
      "p",
      { class: "lead" },
      first ? null : h("a", { href: href("/database/users", { q: query }) }, "« First page"),
      first || !reply.next ? null : " · ",
      reply.next
        ? h("a", { href: href("/database/users", { q: query, after: reply.next }) }, "Next page »")
        : null,
    ),
  );
}
