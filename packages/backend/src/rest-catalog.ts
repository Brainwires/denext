// The auto-REST catalog: which tables, views and functions of the exposed schemas the `anon` /
// `authenticated` roles may reach (by default only relations that enforce row-level security),
// with their columns, keys, foreign keys, enums and composite types, read from `pg_catalog`.
// It is the whitelist every identifier in a REST request is checked against — a schema, table,
// column, function, argument or type name is never taken from a request as text, only looked up
// here and quoted (`quoteIdent`). The same entries drive the generated types (`rest-codegen.ts`).

import type { SqlClient, SqlRow } from "@denext/denext/server";
import {
  type BaseForeignKey,
  inheritedForeignKeys,
  inheritedKeys,
  type LineageEntry,
  parseLineage,
  type RelationInfo,
  type ViewOver,
  viewsOver,
} from "./rest-lineage.ts";

/** One column of an exposed table (or of a function's result). */
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

/** A relation's schema and name. */
export interface RestRelationName {
  /** Its schema. */
  readonly schema: string;
  /** Its name. */
  readonly name: string;
}

/** One exposed table or view. */
export interface RestTable extends RestRelationName {
  /** `table`, `view`, … */
  readonly kind: string;
  /** The columns, in order. */
  readonly columns: readonly RestColumn[];
  /** The primary key's columns (empty for a view or a table without one). */
  readonly primaryKey: readonly string[];
  /** Every unique key (the primary key included), each as its columns. */
  readonly uniqueKeys?: readonly (readonly string[])[];
  /** Its `pg_class` oid (views' column lineage is keyed by it). */
  readonly oid?: string;
}

/** A foreign key between two exposed relations. */
export interface RestForeignKey {
  /** The constraint's name. */
  readonly name: string;
  /** The referencing relation. */
  readonly table: RestRelationName;
  /** Its columns, in key order. */
  readonly columns: readonly string[];
  /** The referenced relation. */
  readonly foreignTable: RestRelationName;
  /** The referenced columns, in key order. */
  readonly foreignColumns: readonly string[];
}

/** The type facts of a column, an argument or a scalar result. */
export type RestTypeFacts = Pick<
  RestColumn,
  "castType" | "typeName" | "category" | "element" | "enumLabels"
>;

/** One input argument of a function. */
export interface RestFunctionArg extends RestTypeFacts {
  /** Its name (`""` when unnamed). */
  readonly name: string;
  /** It may be left out (it has a default). */
  readonly hasDefault: boolean;
  /** `VARIADIC`. */
  readonly variadic: boolean;
  /** For a relation's row type: that relation (a computed field / relationship's argument). */
  readonly relation?: RestRelationName;
}

/** What a function returns. */
export interface RestFunctionResult {
  /**
   * `void`; a `scalar` (a base, enum, domain, range or array type); or a `composite` row whose
   * `columns` are listed (a table's row type, a composite type, or the `OUT` / `TABLE` columns).
   */
  readonly kind: "void" | "scalar" | "composite";
  /** The type as SQL. */
  readonly castType: string;
  /** For a scalar: its type facts (codegen). */
  readonly column?: RestColumn;
  /** For a composite: its columns. */
  readonly columns?: readonly RestColumn[];
  /** For a relation's row type: that relation — its foreign keys apply to embeds. */
  readonly table?: RestRelationName;
}

/** One function the roles may execute. */
export interface RestFunction extends RestRelationName {
  /** Its input arguments, in order. */
  readonly args: readonly RestFunctionArg[];
  /** `i`mmutable, `s`table or `v`olatile. */
  readonly volatility: "i" | "s" | "v";
  /** It returns a set (`SETOF …` / `TABLE (…)`). */
  readonly setOf: boolean;
  /** What it returns. */
  readonly returns: RestFunctionResult;
  /** The planner's `ROWS` estimate (`ROWS 1` makes a set-returning relationship to-one). */
  readonly rows?: number;
}

/** A user-defined composite type (for codegen). */
export interface RestCompositeType extends RestRelationName {
  /** Its attributes. */
  readonly columns: readonly RestColumn[];
}

/** Everything the REST routes may touch, across the exposed schemas. */
export interface RestCatalog {
  /** The exposed schemas, the default first. */
  readonly schemas: readonly string[];
  /** Every exposed relation, by schema then name. */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, RestTable>>;
  /** Foreign keys between exposed relations. */
  readonly foreignKeys: readonly RestForeignKey[];
  /** Every executable function, by schema then name (overloads together). */
  readonly functions: ReadonlyMap<string, ReadonlyMap<string, readonly RestFunction[]>>;
  /** Enums, by schema then name. */
  readonly enums: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** User-defined composite types of the exposed schemas. */
  readonly compositeTypes: readonly RestCompositeType[];
  /**
   * The type names a `::cast` may name, each to its SQL: `pg_catalog`'s as written, the exposed
   * schemas' quoted (by bare name and by `schema.name`).
   */
  readonly castTypes: ReadonlyMap<string, string>;
  /** PostGIS is installed (GeoJSON output). */
  readonly postgis: boolean;
  /**
   * What the secret key (`service_role`) sees: every relation and function of the exposed
   * schemas, as PostgREST serves them to that role — absent on a catalog that is itself it.
   */
  readonly service?: RestCatalog;
}

/**
 * A relation of the catalog, or `undefined`.
 *
 * @param catalog The catalog.
 * @param schema The schema.
 * @param name The relation.
 * @returns The relation.
 */
export function tableIn(
  catalog: RestCatalog,
  schema: string,
  name: string,
): RestTable | undefined {
  return catalog.tables.get(schema)?.get(name);
}

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

/** Whether `role` (when it exists) may execute the function `p`. */
function executable(role: "anon" | "authenticated"): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')
    THEN has_function_privilege('${role}', p.oid, 'EXECUTE') ELSE false END`;
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

/** One row per column of every reachable relation in the schemas `$1`. */
const COLUMNS_SQL = `SELECT n.nspname AS schema, c.relname AS "table", c.relkind::text AS kind,
  c.oid::text AS oid, (${reachable("anon")} OR ${reachable("authenticated")})::text AS reachable,
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
WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY n.nspname, c.relname, a.attnum`;

/** The unique keys (primary first) of every user relation (a view's base table may be anywhere). */
const KEYS_SQL = `SELECT n.nspname AS schema, c.relname AS "table", c.oid::text AS oid,
  i.indisprimary::text AS "primary",
  (SELECT json_agg(a.attname ORDER BY k.ord)
    FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)::text AS columns
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND i.indisunique AND i.indpred IS NULL
  AND NOT (0 = ANY (i.indkey::int2[]))
ORDER BY n.nspname, c.relname, i.indisprimary DESC, i.indexrelid`;

/** Every user foreign key (views expose them through their column lineage). */
const FOREIGN_KEYS_SQL = `SELECT k.conname AS name, n1.nspname AS schema, c1.relname AS "table",
  k.conrelid::text AS oid, k.confrelid::text AS foreign_oid,
  n2.nspname AS foreign_schema, c2.relname AS foreign_table,
  (SELECT json_agg(a.attname ORDER BY x.ord)
    FROM unnest(k.conkey) WITH ORDINALITY AS x(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum)::text AS columns,
  (SELECT json_agg(a.attname ORDER BY x.ord)
    FROM unnest(k.confkey) WITH ORDINALITY AS x(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum)::text
    AS foreign_columns
FROM pg_constraint k
JOIN pg_class c1 ON c1.oid = k.conrelid
JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
JOIN pg_class c2 ON c2.oid = k.confrelid
JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
WHERE k.contype = 'f' AND n1.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n1.nspname NOT LIKE 'pg\\_%' 
ORDER BY n1.nspname, c1.relname, k.conname`;

/**
 * The types a column, argument or result may have, with their base type (a domain's) and
 * category: everything but the row types of `pg_catalog` relations and the toast / temp schemas.
 */
const TYPES_SQL = `SELECT t.oid::text AS oid, n.nspname AS schema, t.typname AS name,
  format_type(t.oid, NULL) AS cast_type, t.typtype::text AS typtype,
  bt.typname AS type_name, bt.typcategory::text AS category,
  et.typname AS element_name, et.typcategory::text AS element_category,
  (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e
    WHERE e.enumtypid = bt.oid)::text AS enum_labels,
  t.typrelid::text AS relid, coalesce(rc.relkind::text, '') AS relkind,
  coalesce(rn.nspname, '') AS rel_schema, coalesce(rc.relname, '') AS rel_name
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
LEFT JOIN pg_type et ON et.oid = bt.typelem AND bt.typcategory = 'A'
LEFT JOIN pg_class rc ON rc.oid = t.typrelid
LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE n.nspname NOT IN ('pg_toast', 'information_schema')
  AND NOT (t.typrelid <> 0 AND n.nspname = 'pg_catalog')
  AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'`;

/** The attributes of every user relation's and composite type's row type. */
const ATTRIBUTES_SQL =
  `SELECT a.attrelid::text AS relid, a.attname AS name, a.attnum::int AS attnum,
  n.nspname AS schema, c.relname AS rel, c.relkind::text AS relkind,
  a.atttypid::text AS type_oid, (NOT a.attnotnull)::text AS nullable
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('c', 'r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY a.attrelid, a.attnum`;

/** The functions of the schemas `$1`, and whether `anon` or `authenticated` may execute each. */
const FUNCTIONS_SQL = `SELECT n.nspname AS schema, p.proname AS name, p.prorows::float8 AS rows,
  (${executable("anon")} OR ${executable("authenticated")})::text AS executable,
  p.provolatile::text AS volatility, p.proretset::text AS set_of,
  p.prorettype::text AS return_oid, p.pronargdefaults::int AS ndefaults,
  (SELECT json_agg(json_build_object(
      'name', coalesce(p.proargnames[x.i], ''),
      'oid', x.t::text,
      'mode', coalesce(p.proargmodes[x.i]::text, 'i')) ORDER BY x.i)
    FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS x(t, i)
  )::text AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type rt ON rt.oid = p.prorettype
WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND p.prokind = 'f'
  AND rt.typname NOT IN ('trigger', 'event_trigger', 'internal', 'language_handler',
    'fdw_handler', 'index_am_handler', 'tsm_handler', 'table_am_handler')
ORDER BY n.nspname, p.proname, p.oid`;

/** The `_RETURN` rule of every view and materialized view of the schemas `$1` (column lineage). */
const VIEWS_SQL = `SELECT c.oid::text AS oid, r.ev_action::text AS action
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_rewrite r ON r.ev_class = c.oid AND r.rulename = '_RETURN'
WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND c.relkind IN ('v', 'm')`;

/** Whether PostGIS is installed. */
const POSTGIS_SQL =
  `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')::text AS postgis`;

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

/** A JSON-array text column of strings. */
function strings(row: SqlRow, key: string): string[] {
  const raw = text(row, key);
  return raw ? JSON.parse(raw) as string[] : [];
}

/** The type facts a row of `COLUMNS_SQL` / `TYPES_SQL` carries. */
function typeFacts(row: SqlRow): RestTypeFacts {
  const elementName = text(row, "element_name");
  const labels = text(row, "enum_labels");
  return {
    castType: String(row.cast_type),
    typeName: String(row.type_name),
    category: String(row.category),
    ...(elementName
      ? { element: { typeName: elementName, category: text(row, "element_category") ?? "X" } }
      : {}),
    ...(labels ? { enumLabels: JSON.parse(labels) as string[] } : {}),
  };
}

/** One catalog row → a column. */
function columnOf(row: SqlRow): RestColumn {
  return {
    name: String(row.name),
    ...typeFacts(row),
    nullable: bool(row, "nullable"),
    hasDefault: bool(row, "has_default"),
    readOnly: bool(row, "read_only"),
  };
}

/** A relation `tables: "*"` left out, and why. */
export interface SkippedRelation {
  /** Its schema. */
  readonly schema: string;
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

/** The kind name of a `relkind`. */
function kindOf(row: SqlRow): string {
  const kind = String(row.kind);
  return KINDS[kind] ?? kind;
}

/** Whether `tables` names the relation (a bare name, or `schema.name`). */
function named(wanted: ReadonlySet<string>, schema: string, table: string): boolean {
  return wanted.has(table) || wanted.has(`${schema}.${table}`);
}

/** The relations grouped from the column rows, by schema then name. */
type Grouped = Map<string, Map<string, { kind: string; oid: string; columns: RestColumn[] }>>;

/** Add `value` under `outer` → `inner` in a two-level map, returning the stored value. */
function nested<V>(map: Map<string, Map<string, V>>, outer: string, inner: string, make: () => V) {
  const level = map.get(outer) ?? new Map<string, V>();
  map.set(outer, level);
  const value = level.get(inner) ?? make();
  level.set(inner, value);
  return value;
}

/** Whether a reachable relation is served to `anon` / `authenticated` (and if not, why). */
function served(row: SqlRow, wanted: ReadonlySet<string> | null): boolean {
  return wanted ? named(wanted, String(row.schema), String(row.table)) : bool(row, "rls");
}

/**
 * Group the column rows by relation. For the RLS roles: the reachable relations `tables`
 * exposes (a list: exactly its names; `"*"`: the RLS-enforcing ones), and — for `"*"` — the
 * reachable relations it left out. For `"service"`: every relation of the schemas.
 */
function groupColumns(
  rows: Iterable<SqlRow>,
  tables: readonly string[] | "*" | "service",
): { grouped: Grouped; skipped: SkippedRelation[] } {
  const wanted = tables === "*" || tables === "service" ? null : new Set(tables);
  const grouped: Grouped = new Map();
  const skipped = new Map<string, SkippedRelation>();
  for (const row of rows) {
    const schema = String(row.schema);
    const table = String(row.table);
    if (tables !== "service") {
      if (!bool(row, "reachable")) continue;
      if (!served(row, wanted)) {
        if (!wanted) {
          skipped.set(`${schema}.${table}`, {
            schema,
            name: table,
            kind: kindOf(row),
            reason: skipReason(String(row.kind)),
          });
        }
        continue;
      }
    }
    nested(grouped, schema, table, () => ({
      kind: kindOf(row),
      oid: String(row.oid ?? ""),
      columns: [] as RestColumn[],
    })).columns.push(columnOf(row));
  }
  return { grouped, skipped: [...skipped.values()] };
}

/** A type of `TYPES_SQL`. */
interface TypeRow {
  schema: string;
  name: string;
  typtype: string;
  facts: RestTypeFacts;
  relid: string;
  relkind: string;
  relSchema: string;
  relName: string;
}

/** `TYPES_SQL`'s rows by oid. */
function typeMap(rows: Iterable<SqlRow>): Map<string, TypeRow> {
  const map = new Map<string, TypeRow>();
  for (const row of rows) {
    map.set(String(row.oid), {
      schema: String(row.schema),
      name: String(row.name),
      typtype: String(row.typtype),
      facts: typeFacts(row),
      relid: String(row.relid),
      relkind: String(row.relkind),
      relSchema: String(row.rel_schema),
      relName: String(row.rel_name),
    });
  }
  return map;
}

/** The facts of a type `TYPES_SQL` did not list. */
const UNKNOWN_TYPE: RestTypeFacts = { castType: "unknown", typeName: "unknown", category: "X" };

/** A column of a composite or of a function's `OUT` list. */
function syntheticColumn(name: string, type: TypeRow | undefined, nullable = true): RestColumn {
  return {
    name,
    ...(type?.facts ?? UNKNOWN_TYPE),
    nullable,
    hasDefault: false,
    readOnly: false,
  };
}

/** Row-type attributes by `relid`. */
function attributeMap(
  rows: Iterable<SqlRow>,
  types: Map<string, TypeRow>,
): Map<string, RestColumn[]> {
  const map = new Map<string, RestColumn[]>();
  for (const row of rows) {
    const relid = String(row.relid);
    const list = map.get(relid) ?? [];
    map.set(relid, list);
    const type = types.get(String(row.type_oid));
    list.push(syntheticColumn(String(row.name), type, bool(row, "nullable")));
  }
  return map;
}

/** One raw argument of `FUNCTIONS_SQL`. */
interface RawArg {
  name: string;
  oid: string;
  mode: string;
}

/** What a function returns, from its return type and its `OUT` / `TABLE` arguments. */
function returnsOf(
  returnOid: string,
  outs: RawArg[],
  types: Map<string, TypeRow>,
  attributes: Map<string, RestColumn[]>,
): RestFunctionResult {
  const type = types.get(returnOid);
  const castType = type?.facts.castType ?? "unknown";
  if (type?.name === "void") return { kind: "void", castType };
  if (outs.length > 1 || (outs.length === 1 && type?.name === "record")) {
    const columns = outs.map((a, i) =>
      syntheticColumn(a.name || `column${i + 1}`, types.get(a.oid))
    );
    return { kind: "composite", castType, columns };
  }
  if (type && type.relid !== "0") {
    const table = type.relkind === "c" ? undefined : { schema: type.relSchema, name: type.relName };
    return {
      kind: "composite",
      castType,
      columns: attributes.get(type.relid) ?? [],
      ...(table ? { table } : {}),
    };
  }
  return { kind: "scalar", castType, column: syntheticColumn("", type) };
}

/** One `FUNCTIONS_SQL` row → a function (or `undefined` for one REST cannot call). */
function functionOf(
  row: SqlRow,
  types: Map<string, TypeRow>,
  attributes: Map<string, RestColumn[]>,
): RestFunction | undefined {
  const raw = JSON.parse(text(row, "args") ?? "[]") as RawArg[];
  const inputs = raw.filter((a) => a.mode === "i" || a.mode === "b" || a.mode === "v");
  const outs = raw.filter((a) => a.mode === "o" || a.mode === "b" || a.mode === "t");
  const returns = returnsOf(String(row.return_oid), outs, types, attributes);
  // `RETURNS record` without OUT columns needs a column list at the call site.
  if (returns.kind === "scalar" && returns.castType === "record") return undefined;
  const defaults = Number(row.ndefaults ?? 0);
  const args = inputs.map((arg, i): RestFunctionArg => {
    const type = types.get(arg.oid);
    const relation = type && type.relid !== "0" && type.relkind !== "c"
      ? { relation: { schema: type.relSchema, name: type.relName } }
      : {};
    return {
      name: arg.name,
      ...(type?.facts ?? UNKNOWN_TYPE),
      hasDefault: i >= inputs.length - defaults,
      variadic: arg.mode === "v",
      ...relation,
    };
  });
  const volatility = String(row.volatility);
  return {
    schema: String(row.schema),
    name: String(row.name),
    args,
    volatility: volatility === "i" || volatility === "s" ? volatility : "v",
    setOf: bool(row, "set_of"),
    returns,
    ...(row.rows === null || row.rows === undefined ? {} : { rows: Number(row.rows) }),
  };
}

/** Group functions by schema then name. */
function groupFunctions(list: RestFunction[]): Map<string, Map<string, RestFunction[]>> {
  const map = new Map<string, Map<string, RestFunction[]>>();
  for (const fn of list) nested(map, fn.schema, fn.name, () => [] as RestFunction[]).push(fn);
  return map;
}

/** SQL spellings of built-in types that are neither a `typname` nor a `format_type` result. */
const CAST_ALIASES = ["int", "float", "decimal", "char", "varchar", "timestamptz", "timetz"];

/** A quoted `schema.name`. */
function qualifiedName(schema: string, name: string): string {
  return `"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`;
}

/** The `::cast` whitelist: built-in names as written, the exposed schemas' types quoted. */
function castTypesOf(types: Map<string, TypeRow>, schemas: readonly string[]): Map<string, string> {
  const casts = new Map<string, string>(CAST_ALIASES.map((name) => [name, name]));
  const user: Array<[string, string]> = [];
  for (const type of types.values()) {
    if (type.relid !== "0" && type.relkind !== "c") continue;
    if (type.schema === "pg_catalog") addBuiltinCast(casts, type);
    else if (schemas.includes(type.schema) && !type.name.startsWith("_")) {
      const sql = qualifiedName(type.schema, type.name);
      casts.set(`${type.schema}.${type.name}`, sql);
      user.push([type.name, sql]);
    }
  }
  for (const [name, sql] of user) if (!casts.has(name)) casts.set(name, sql);
  return casts;
}

/** A built-in type's spellings (its `typname` and its `format_type` name) as plain SQL. */
function addBuiltinCast(casts: Map<string, string>, type: TypeRow): void {
  for (const name of [type.name, type.facts.castType]) {
    if (/^[a-z_][a-z0-9_ ]*(\[\])?$/.test(name)) casts.set(name, name);
  }
}

/** Enums of the exposed schemas, by schema then name. */
function enumsOf(
  types: Map<string, TypeRow>,
  schemas: readonly string[],
): Map<string, Map<string, string[]>> {
  const map = new Map<string, Map<string, string[]>>();
  for (const type of types.values()) {
    if (type.typtype !== "e" || !schemas.includes(type.schema)) continue;
    nested(map, type.schema, type.name, () => [...type.facts.enumLabels ?? []]);
  }
  return map;
}

/** Standalone composite types (`create type … as (…)`) of the exposed schemas. */
function compositesOf(
  types: Map<string, TypeRow>,
  attributes: Map<string, RestColumn[]>,
  schemas: readonly string[],
): RestCompositeType[] {
  return [...types.values()]
    .filter((t) => t.relkind === "c" && schemas.includes(t.schema))
    .map((t) => ({ schema: t.schema, name: t.name, columns: attributes.get(t.relid) ?? [] }));
}

/** The unique keys of one relation: its primary key and every unique key. */
interface Keys {
  primary: string[];
  unique: string[][];
}

/** The key rows, by relation oid. */
function keyMap(rows: Iterable<SqlRow>): Map<string, Keys> {
  const map = new Map<string, Keys>();
  for (const row of rows) {
    const key = String(row.oid);
    const entry = map.get(key) ?? { primary: [], unique: [] };
    map.set(key, entry);
    const columns = strings(row, "columns");
    if (bool(row, "primary")) entry.primary = columns;
    entry.unique.push(columns);
  }
  return map;
}

/** The base foreign keys, with their ends' oids. */
function baseForeignKeys(rows: Iterable<SqlRow>): BaseForeignKey[] {
  return [...rows].map((row) => ({
    name: String(row.name),
    oid: String(row.oid),
    foreignOid: String(row.foreign_oid),
    table: { schema: String(row.schema), name: String(row.table) },
    columns: strings(row, "columns"),
    foreignTable: { schema: String(row.foreign_schema), name: String(row.foreign_table) },
    foreignColumns: strings(row, "foreign_columns"),
  }));
}

/** The foreign keys (views' inherited ones included) whose two ends are both exposed. */
function exposedForeignKeys(
  keys: readonly RestForeignKey[],
  tables: Map<string, Map<string, RestTable>>,
): RestForeignKey[] {
  const exposed = (r: RestRelationName) => tables.get(r.schema)?.has(r.name) ?? false;
  const seen = new Set<string>();
  return keys.filter((fk) => {
    if (!exposed(fk.table) || !exposed(fk.foreignTable)) return false;
    const id = JSON.stringify([fk.name, fk.table, fk.columns, fk.foreignTable, fk.foreignColumns]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Every user relation by oid: its name and its column names by attnum. */
function relationMap(rows: Iterable<SqlRow>): Map<string, RelationInfo> {
  const map = new Map<string, { schema: string; name: string; columns: Map<number, string> }>();
  for (const row of rows) {
    const oid = String(row.relid);
    const entry = map.get(oid) ??
      { schema: String(row.schema), name: String(row.rel), columns: new Map<number, string>() };
    map.set(oid, entry);
    entry.columns.set(Number(row.attnum), String(row.name));
  }
  return map;
}

/** A view's keys: its own (a materialized view's unique indexes), else its base tables'. */
function viewKeys(
  oid: string,
  keys: Map<string, Keys>,
  overs: ReadonlyMap<string, ViewOver[]>,
): Keys | undefined {
  const own = keys.get(oid);
  if (own?.unique.length) return own;
  const inherited: Keys = { primary: [], unique: [] };
  for (const [baseOid, list] of overs) {
    const base = keys.get(baseOid);
    if (!base) continue;
    for (const over of list.filter((o) => o.oid === oid)) {
      inherited.unique.push(...inheritedKeys(base.unique, over));
      const [primary] = inheritedKeys([base.primary], over);
      if (primary?.length && !inherited.primary.length) inherited.primary = primary;
    }
  }
  return inherited;
}

/** Build the relations from the grouped columns and the keys. */
function tablesOf(
  grouped: Grouped,
  keys: Map<string, Keys>,
  overs: ReadonlyMap<string, ViewOver[]>,
): Map<string, Map<string, RestTable>> {
  const tables = new Map<string, Map<string, RestTable>>();
  for (const [schema, relations] of grouped) {
    const inSchema = new Map<string, RestTable>();
    tables.set(schema, inSchema);
    for (const [name, entry] of relations) {
      const key = entry.kind === "view" || entry.kind === "materialized view"
        ? viewKeys(entry.oid, keys, overs)
        : keys.get(entry.oid);
      inSchema.set(name, {
        schema,
        name,
        kind: entry.kind,
        columns: entry.columns,
        primaryKey: key?.primary ?? [],
        uniqueKeys: key?.unique ?? [],
        oid: entry.oid,
      });
    }
  }
  return tables;
}

/** The raw catalog rows, read once for both audiences. */
interface CatalogRows {
  columns: SqlRow[];
  keys: SqlRow[];
  foreignKeys: SqlRow[];
  types: SqlRow[];
  attributes: SqlRow[];
  functions: SqlRow[];
  views: SqlRow[];
  postgis: boolean;
}

/** Read every catalog query. */
async function readRows(sql: SqlClient, schemas: readonly string[]): Promise<CatalogRows> {
  const json = JSON.stringify([...schemas]);
  const all = (text: string, params: unknown[]) =>
    sql.unsafe(text, params).then((rows) => [...rows]);
  const columns = await all(COLUMNS_SQL, [json]);
  const keys = await all(KEYS_SQL, []);
  const foreignKeys = await all(FOREIGN_KEYS_SQL, []);
  const types = await all(TYPES_SQL, []);
  const attributes = await all(ATTRIBUTES_SQL, []);
  const functions = await all(FUNCTIONS_SQL, [json]);
  const views = await all(VIEWS_SQL, [json]);
  const [postgis] = await all(POSTGIS_SQL, []);
  return {
    columns,
    keys,
    foreignKeys,
    types,
    attributes,
    functions,
    views,
    postgis: postgis !== undefined && bool(postgis, "postgis"),
  };
}

/** Each view's (by oid) traced columns. */
function lineageOf(rows: readonly SqlRow[]): Map<string, LineageEntry[]> {
  return new Map(rows.map((row) => [String(row.oid), parseLineage(String(row.action ?? ""))]));
}

/**
 * Read the catalog of `schemas`: the tables, views, materialized views and foreign tables the
 * `anon` or `authenticated` role holds a privilege on (`SELECT`, `INSERT`, `UPDATE` on any
 * column, or `DELETE`), the foreign keys between them (views inherit their base tables' keys
 * through their column lineage), the functions those roles may execute, and the enums and
 * composite types. Its `service` member is the same for the secret key (`service_role`): every
 * relation and function of the schemas.
 *
 * With `tables: "*"` only relations that enforce row-level security for the caller are kept —
 * tables with RLS enabled and `security_invoker` views; every other reachable relation is
 * reported to `onSkipped` instead. A list exposes exactly the named relations (a bare name in
 * any exposed schema, or `schema.name`) that the roles can reach, whatever their RLS: naming one
 * is the operator's decision.
 *
 * @param sql The connecting role's client (catalog reads carry no user data).
 * @param schemas The exposed schemas, the default first.
 * @param tables The relations to expose, or `"*"` for every reachable, RLS-enforcing one.
 * @param onSkipped Receives the relations `"*"` left out (called once, possibly empty).
 * @returns The catalog.
 */
export async function readRestCatalog(
  sql: SqlClient,
  schemas: readonly string[],
  tables: readonly string[] | "*",
  onSkipped?: (skipped: SkippedRelation[]) => void,
): Promise<RestCatalog> {
  const list = [...schemas];
  const rows = await readRows(sql, list);
  const types = typeMap(rows.types);
  const attributes = attributeMap(rows.attributes, types);
  const keys = keyMap(rows.keys);
  const overs = viewsOver(lineageOf(rows.views), relationMap(rows.attributes));
  const foreignKeys = inheritedForeignKeys(baseForeignKeys(rows.foreignKeys), overs);
  const functions = rows.functions
    .map((row) => ({ fn: functionOf(row, types, attributes), executable: bool(row, "executable") }))
    .filter((f): f is { fn: RestFunction; executable: boolean } => f.fn !== undefined);
  const shared = {
    schemas: list,
    enums: enumsOf(types, list),
    compositeTypes: compositesOf(types, attributes, list),
    castTypes: castTypesOf(types, list),
    postgis: rows.postgis,
  };
  const build = (grouped: Grouped, fns: RestFunction[]): RestCatalog => {
    const relations = tablesOf(grouped, keys, overs);
    return {
      ...shared,
      tables: relations,
      foreignKeys: exposedForeignKeys(foreignKeys, relations),
      functions: groupFunctions(fns),
    };
  };
  const { grouped, skipped } = groupColumns(rows.columns, tables);
  const service = build(groupColumns(rows.columns, "service").grouped, functions.map((f) => f.fn));
  onSkipped?.(skipped);
  return {
    ...build(grouped, functions.filter((f) => f.executable).map((f) => f.fn)),
    service,
  };
}
