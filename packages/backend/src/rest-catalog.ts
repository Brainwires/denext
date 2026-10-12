// The auto-REST catalog: which tables and views of one schema the `anon` / `authenticated` roles
// may reach (by default only those that enforce row-level security), with their columns and
// primary keys, read from `pg_catalog`. It is the whitelist
// every identifier in a REST request is checked against — a table, column or type name is never
// taken from a request as text, only looked up here and quoted (`quoteIdent`). The same entries
// drive the generated row types (`rest-codegen.ts`).

import type { SqlClient, SqlRow } from "@denext/denext/server";

/** One column of an exposed table. */
export interface RestColumn {
  /** Its name. */
  readonly name: string;
  /** Its type without a modifier — what a value is cast to (`character varying`, `integer[]`). */
  readonly castType: string;
  /** `pg_type.typname` of the column's (base) type (`int4`, `jsonb`, `_text`). */
  readonly typeName: string;
  /** `pg_type.typcategory` of the column's (base) type (`N`, `S`, `B`, `A`, …). */
  readonly category: string;
  /** For an array column: the element type's name and category. */
  readonly element?: { readonly typeName: string; readonly category: string };
  /** An enum's labels, in order. */
  readonly enumLabels?: readonly string[];
  /** It may be NULL. */
  readonly nullable: boolean;
  /** It has a default (or is an identity column), so an insert may leave it out. */
  readonly hasDefault: boolean;
  /** A generated column, or `GENERATED ALWAYS AS IDENTITY`: never written. */
  readonly readOnly: boolean;
}

/** One exposed table or view. */
export interface RestTable {
  /** Its schema. */
  readonly schema: string;
  /** Its name — the REST path segment. */
  readonly name: string;
  /** `table`, `view`, … */
  readonly kind: string;
  /** The columns, in order. */
  readonly columns: readonly RestColumn[];
  /** The primary key's columns (empty for a view or a table without one). */
  readonly primaryKey: readonly string[];
}

/** Every exposed table of one schema, by name. */
export type RestCatalog = ReadonlyMap<string, RestTable>;

/** `pg_class.relkind` → a kind name. */
const KINDS: Record<string, string> = {
  r: "table",
  p: "table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

/**
 * Whether `role` (when it exists) holds any privilege a REST route uses on the relation `c`.
 * `CASE` guards the privilege functions, which raise for a role that does not exist yet.
 */
function reachable(role: "anon" | "authenticated"): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')
    THEN has_any_column_privilege('${role}', c.oid, 'SELECT, INSERT, UPDATE')
      OR has_table_privilege('${role}', c.oid, 'DELETE')
    ELSE false END`;
}

/**
 * Whether the relation `c` enforces row-level security for the caller: a table (or partitioned
 * table) with RLS enabled, or a view declared `security_invoker` (Postgres 15+), whose base
 * tables' policies then apply to the querying role instead of the view owner's rights.
 */
const RLS_ENFORCED = `CASE
    WHEN c.relkind IN ('r', 'p') THEN c.relrowsecurity
    WHEN c.relkind = 'v' THEN EXISTS (SELECT 1 FROM unnest(c.reloptions) AS o(opt)
      WHERE lower(o.opt) ~ '^security_invoker=(t|tr|tru|true|y|ye|yes|on|1)$')
    ELSE false END`;

/** One row per column of every reachable relation in schema `$1`. */
const COLUMNS_SQL = `SELECT c.relname AS "table", c.relkind::text AS kind,
  (${RLS_ENFORCED})::text AS rls, a.attname AS name,
  format_type(a.atttypid, NULL) AS cast_type,
  bt.typname AS type_name, bt.typcategory::text AS category,
  et.typname AS element_name, et.typcategory::text AS element_category,
  (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e
    WHERE e.enumtypid = bt.oid)::text AS enum_labels,
  (NOT a.attnotnull)::text AS nullable,
  (d.adbin IS NOT NULL OR a.attidentity <> '')::text AS has_default,
  (a.attgenerated <> '' OR a.attidentity = 'a')::text AS read_only
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
LEFT JOIN pg_type et ON et.oid = bt.typelem AND bt.typcategory = 'A'
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (${reachable("anon")} OR ${reachable("authenticated")})
ORDER BY c.relname, a.attnum`;

/** The primary keys of the tables in schema `$1`, column by column in key order. */
const KEYS_SQL = `SELECT c.relname AS "table", a.attname AS name
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
WHERE n.nspname = $1 AND i.indisprimary
ORDER BY c.relname, k.ord`;

/** A `'true'` / `'false'` text column (or a real boolean) as a boolean. */
function bool(row: SqlRow, key: string): boolean {
  const value = row[key];
  return value === true || value === "true" || value === "t";
}

/** An optional text column. */
function text(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

/** One catalog row → a column. */
function columnOf(row: SqlRow): RestColumn {
  const elementName = text(row, "element_name");
  const labels = text(row, "enum_labels");
  return {
    name: String(row.name),
    castType: String(row.cast_type),
    typeName: String(row.type_name),
    category: String(row.category),
    ...(elementName
      ? { element: { typeName: elementName, category: text(row, "element_category") ?? "X" } }
      : {}),
    ...(labels ? { enumLabels: JSON.parse(labels) as string[] } : {}),
    nullable: bool(row, "nullable"),
    hasDefault: bool(row, "has_default"),
    readOnly: bool(row, "read_only"),
  };
}

/** A relation `tables: "*"` left out, and why. */
export interface SkippedRelation {
  /** Its name. */
  readonly name: string;
  /** `table`, `view`, `materialized view`, `foreign table`. */
  readonly kind: string;
  /** Why it got no route. */
  readonly reason: string;
}

/** Why a relation that does not enforce row-level security is left out of `"*"`. */
function skipReason(kind: string): string {
  switch (kind) {
    case "r":
    case "p":
      return "row-level security is not enabled";
    case "v":
      return "a view without security_invoker runs with its owner's rights";
    case "m":
      return "a materialized view has no row-level security";
    default:
      return "a foreign table has no row-level security";
  }
}

/**
 * Read the catalog: the tables, views, materialized views and foreign tables of `schema` that
 * the `anon` or `authenticated` role holds a privilege on (`SELECT`, `INSERT`, `UPDATE` on any
 * column, or `DELETE`).
 *
 * With `tables: "*"` only relations that enforce row-level security for the caller are kept —
 * tables with RLS enabled and `security_invoker` views; every other reachable relation is
 * reported to `onSkipped` instead. A list exposes exactly the named relations (that the roles can
 * reach), whatever their RLS: naming one is the operator's decision.
 *
 * @param sql The connecting role's client (catalog reads carry no user data).
 * @param schema The schema.
 * @param tables The table names to expose, or `"*"` for every reachable, RLS-enforcing one.
 * @param onSkipped Receives the relations `"*"` left out (called once, possibly empty).
 * @returns The catalog.
 */
export async function readRestCatalog(
  sql: SqlClient,
  schema: string,
  tables: readonly string[] | "*",
  onSkipped?: (skipped: SkippedRelation[]) => void,
): Promise<RestCatalog> {
  const columnRows = await sql.unsafe(COLUMNS_SQL, [schema]);
  const keyRows = await sql.unsafe(KEYS_SQL, [schema]);
  const { columns, skipped } = groupColumns(columnRows, tables);
  const keys = new Map<string, string[]>();
  for (const row of keyRows) {
    const table = String(row.table);
    keys.set(table, [...keys.get(table) ?? [], String(row.name)]);
  }
  const catalog = new Map<string, RestTable>();
  for (const [name, entry] of columns) {
    catalog.set(name, {
      schema,
      name,
      kind: entry.kind,
      columns: entry.columns,
      primaryKey: keys.get(name) ?? [],
    });
  }
  onSkipped?.(skipped);
  return catalog;
}

/** The kind name of a `relkind`. */
function kindOf(row: SqlRow): string {
  const kind = String(row.kind);
  return KINDS[kind] ?? kind;
}

/**
 * Group the column rows by relation: those `tables` exposes (a list: exactly its names; `"*"`:
 * the RLS-enforcing ones), and — for `"*"` — the reachable relations it left out.
 */
function groupColumns(
  rows: Iterable<SqlRow>,
  tables: readonly string[] | "*",
): {
  columns: Map<string, { kind: string; columns: RestColumn[] }>;
  skipped: SkippedRelation[];
} {
  const wanted = tables === "*" ? null : new Set(tables);
  const columns = new Map<string, { kind: string; columns: RestColumn[] }>();
  const skipped = new Map<string, SkippedRelation>();
  for (const row of rows) {
    const table = String(row.table);
    if (wanted ? !wanted.has(table) : !bool(row, "rls")) {
      if (!wanted) {
        skipped.set(table, {
          name: table,
          kind: kindOf(row),
          reason: skipReason(String(row.kind)),
        });
      }
      continue;
    }
    const entry = columns.get(table) ?? { kind: kindOf(row), columns: [] };
    columns.set(table, entry);
    entry.columns.push(columnOf(row));
  }
  return { columns, skipped: [...skipped.values()] };
}
