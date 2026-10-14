// Schema snapshots and their diff, for `denext db diff`: read what a database's schemas contain
// from the catalog (tables, columns, constraints, indexes, row-level security and its policies,
// functions, views, triggers, enum types), compare two snapshots, and print the DDL that turns
// the first into the second. Grants, sequences' own settings, comments and extensions are not
// compared.

import type { SqlClient } from "@denext/denext/server";

/** One column. */
export interface ColumnSnapshot {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: "" | "a" | "d";
  generated: string | null;
}

/** One table. */
export interface TableSnapshot {
  schema: string;
  name: string;
  rls: boolean;
  columns: ColumnSnapshot[];
  /** Constraint name → definition (`PRIMARY KEY (id)`). */
  constraints: Record<string, string>;
}

/** Everything compared, keyed by qualified name. */
export interface SchemaSnapshot {
  tables: Record<string, TableSnapshot>;
  /** Index name (qualified) → `CREATE INDEX …`. */
  indexes: Record<string, string>;
  /** `schema.table.policy` → policy. */
  policies: Record<string, PolicySnapshot>;
  /** `schema.name(args)` → `CREATE OR REPLACE FUNCTION …`. */
  functions: Record<string, string>;
  /** `schema.view` → its definition. */
  views: Record<string, string>;
  /** `schema.table.trigger` → `CREATE TRIGGER …`. */
  triggers: Record<string, string>;
  /** `schema.type` → its labels in order. */
  enums: Record<string, string[]>;
}

/** One row-level security policy. */
export interface PolicySnapshot {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  roles: string[];
  command: string;
  using: string | null;
  check: string | null;
}

/** A snapshot of nothing (what `db pull` compares against with no shadow database). */
export function emptySnapshot(): SchemaSnapshot {
  return {
    tables: {},
    indexes: {},
    policies: {},
    functions: {},
    views: {},
    triggers: {},
    enums: {},
  };
}

/** `"name"` quoted when it needs to be. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Read a snapshot of `schemas` from the catalog.
 *
 * @param sql The client (any role that can read the catalog).
 * @param schemas The schemas to compare.
 * @returns The snapshot.
 */
export async function readSnapshot(sql: SqlClient, schemas: string[]): Promise<SchemaSnapshot> {
  const snap: SchemaSnapshot = {
    tables: {},
    indexes: {},
    policies: {},
    functions: {},
    views: {},
    triggers: {},
    enums: {},
  };
  const all = <T>(text: string) => sql.unsafe<T>(text, [schemas]).then((rows) => [...rows]);
  const extensionOwned =
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = %s AND d.deptype = 'e')`;
  for (
    const t of await all<{ schema: string; name: string; rls: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1) AND ${
        extensionOwned.replace("%s", "c.oid")
      }
       ORDER BY 1, 2`,
    )
  ) {
    snap.tables[`${t.schema}.${t.name}`] = { ...t, columns: [], constraints: {} };
  }
  for (
    const c of await all<ColumnSnapshot & { schema: string; table: string }>(
      `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
         CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS "default",
         CASE a.attidentity WHEN 'a' THEN 'a' WHEN 'd' THEN 'd' ELSE '' END AS identity,
         CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY 1, 2, a.attnum`,
    )
  ) {
    const { schema, table, ...column } = c;
    snap.tables[`${schema}.${table}`]?.columns.push({ ...column, identity: column.identity ?? "" });
  }
  for (
    const k of await all<{ schema: string; table: string; name: string; def: string }>(
      `SELECT n.nspname AS schema, c.relname AS "table", k.conname AS name,
         pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($1) AND k.contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY 1, 2, 3`,
    )
  ) {
    const table = snap.tables[`${k.schema}.${k.table}`];
    if (table) table.constraints[k.name] = k.def;
  }
  for (
    const i of await all<{ schema: string; name: string; def: string }>(
      `SELECT n.nspname AS schema, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = ic.relnamespace
       WHERE n.nspname = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
         AND ${extensionOwned.replace("%s", "i.indrelid")}
       ORDER BY 1, 2`,
    )
  ) snap.indexes[`${i.schema}.${i.name}`] = i.def;
  for (
    const p of await all<Omit<PolicySnapshot, "permissive"> & { permissive: unknown }>(
      `SELECT schemaname AS schema, tablename AS "table", policyname AS name,
         permissive = 'PERMISSIVE' AS permissive, roles::text[] AS roles, cmd AS command,
         qual AS using, with_check AS check
       FROM pg_policies WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
    )
  ) {
    snap.policies[`${p.schema}.${p.table}.${p.name}`] = {
      ...p,
      permissive: p.permissive === true || p.permissive === "true",
      roles: [...p.roles].sort(),
    };
  }
  for (
    const f of await all<{ key: string; def: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
         pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p') AND ${
        extensionOwned.replace("%s", "p.oid")
      }
       ORDER BY 1`,
    )
  ) snap.functions[f.key] = f.def.trim();
  for (
    const v of await all<{ schema: string; name: string; def: string }>(
      `SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'v' AND n.nspname = ANY($1) AND ${extensionOwned.replace("%s", "c.oid")}
       ORDER BY 1, 2`,
    )
  ) snap.views[`${v.schema}.${v.name}`] = v.def.trim();
  for (
    const t of await all<{ schema: string; table: string; name: string; def: string }>(
      `SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name,
         pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = ANY($1) ORDER BY 1, 2, 3`,
    )
  ) snap.triggers[`${t.schema}.${t.table}.${t.name}`] = t.def;
  for (
    const e of await all<{ schema: string; name: string; labels: string[] }>(
      `SELECT n.nspname AS schema, t.typname AS name,
         array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY($1) AND ${extensionOwned.replace("%s", "t.oid")}
       GROUP BY 1, 2 ORDER BY 1, 2`,
    )
  ) snap.enums[`${e.schema}.${e.name}`] = [...e.labels];
  return snap;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function columnDef(c: ColumnSnapshot): string {
  let def = `${quoteIdent(c.name)} ${c.type}`;
  if (c.generated) def += ` GENERATED ALWAYS AS (${c.generated}) STORED`;
  else if (c.identity) {
    def += ` GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
  } else if (c.default !== null) def += ` DEFAULT ${c.default}`;
  if (c.notNull) def += " NOT NULL";
  return def;
}

function policyDef(p: PolicySnapshot): string {
  let def = `CREATE POLICY ${quoteIdent(p.name)} ON ${qualified(p.schema, p.table)}`;
  if (!p.permissive) def += " AS RESTRICTIVE";
  def += ` FOR ${p.command}`;
  def += ` TO ${p.roles.map((r) => (r === "public" ? "public" : quoteIdent(r))).join(", ")}`;
  if (p.using !== null) def += ` USING (${p.using})`;
  if (p.check !== null) def += ` WITH CHECK (${p.check})`;
  return def + ";";
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf(".");
  return [key.slice(0, at), key.slice(at + 1)];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The statements that change one column that exists on both sides. */
function alterColumn(table: string, old: ColumnSnapshot, c: ColumnSnapshot): string[] {
  const out: string[] = [];
  const col = `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(c.name)}`;
  if (old.type !== c.type) {
    out.push(`${col} TYPE ${c.type} USING ${quoteIdent(c.name)}::${c.type};`);
  }
  if (old.default !== c.default && !c.identity && !c.generated) {
    out.push(c.default === null ? `${col} DROP DEFAULT;` : `${col} SET DEFAULT ${c.default};`);
  }
  if (old.notNull !== c.notNull) out.push(`${col} ${c.notNull ? "SET" : "DROP"} NOT NULL;`);
  return out;
}

/** Added, changed and dropped columns. */
function alterColumns(table: string, from: TableSnapshot, to: TableSnapshot): string[] {
  const before = new Map(from.columns.map((c) => [c.name, c]));
  const after = new Set(to.columns.map((c) => c.name));
  const out = to.columns.flatMap((c) => {
    const old = before.get(c.name);
    return old ? alterColumn(table, old, c) : [`ALTER TABLE ${table} ADD COLUMN ${columnDef(c)};`];
  });
  for (const c of from.columns.filter((c) => !after.has(c.name))) {
    out.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(c.name)};`);
  }
  return out;
}

/** Constraints that changed are dropped and added again; new ones added; gone ones dropped. */
function alterConstraints(table: string, from: TableSnapshot, to: TableSnapshot): string[] {
  return [
    ...changedOrGone(from.constraints, to.constraints).map((name) =>
      `ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(name)};`
    ),
    ...changedOrNew(from.constraints, to.constraints).map((name) =>
      `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(name)} ${to.constraints[name]};`
    ),
  ];
}

/** The statements for one table that exists on both sides. */
function alterTable(from: TableSnapshot, to: TableSnapshot): string[] {
  const table = qualified(to.schema, to.name);
  const out = [...alterColumns(table, from, to), ...alterConstraints(table, from, to)];
  if (from.rls !== to.rls) {
    out.push(`ALTER TABLE ${table} ${to.rls ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`);
  }
  return out;
}

function createTable(t: TableSnapshot): string[] {
  const parts = [
    ...t.columns.map(columnDef),
    ...Object.entries(t.constraints)
      .filter(([, def]) => !def.startsWith("FOREIGN KEY"))
      .map(([name, def]) => `CONSTRAINT ${quoteIdent(name)} ${def}`),
  ];
  const out = [`CREATE TABLE ${qualified(t.schema, t.name)} (\n  ${parts.join(",\n  ")}\n);`];
  if (t.rls) out.push(`ALTER TABLE ${qualified(t.schema, t.name)} ENABLE ROW LEVEL SECURITY;`);
  return out;
}

/** Foreign keys of new tables, added after every table exists. */
function foreignKeys(t: TableSnapshot): string[] {
  return Object.entries(t.constraints)
    .filter(([, def]) => def.startsWith("FOREIGN KEY"))
    .map(([name, def]) =>
      `ALTER TABLE ${qualified(t.schema, t.name)} ADD CONSTRAINT ${quoteIdent(name)} ${def};`
    );
}

/** `DROP FUNCTION schema.name(args)` from a function key. */
function dropFunction(key: string): string {
  const [schema, rest] = splitKey(key);
  const open = rest.indexOf("(");
  return `DROP FUNCTION ${qualified(schema, rest.slice(0, open))}${rest.slice(open)};`;
}

function diffEnums(from: SchemaSnapshot, to: SchemaSnapshot, out: string[]): void {
  for (const [key, labels] of Object.entries(to.enums)) {
    const [schema, name] = splitKey(key);
    const old = from.enums[key];
    if (!old) {
      out.push(
        `CREATE TYPE ${qualified(schema, name)} AS ENUM (${labels.map(literal).join(", ")});`,
      );
      continue;
    }
    for (const label of labels.filter((l) => !old.includes(l))) {
      out.push(`ALTER TYPE ${qualified(schema, name)} ADD VALUE IF NOT EXISTS ${literal(label)};`);
    }
    for (const label of old.filter((l) => !labels.includes(l))) {
      out.push(
        `-- ${qualified(schema, name)}: the label ${
          literal(label)
        } was removed (recreate the type by hand)`,
      );
    }
  }
}

function diffTables(from: SchemaSnapshot, to: SchemaSnapshot, out: string[]): void {
  const added: TableSnapshot[] = [];
  for (const [key, table] of Object.entries(to.tables)) {
    const old = from.tables[key];
    if (!old) {
      out.push(...createTable(table));
      added.push(table);
    } else out.push(...alterTable(old, table));
  }
  for (const table of added) out.push(...foreignKeys(table));
  for (const [key, table] of Object.entries(from.tables)) {
    if (!to.tables[key]) out.push(`DROP TABLE ${qualified(table.schema, table.name)};`);
  }
}

/** The keys of `from` whose definition changed or went away in `to`. */
function changedOrGone<T>(from: Record<string, T>, to: Record<string, T>): string[] {
  return Object.keys(from).filter((key) => !sameJson(from[key], to[key]));
}

/** The keys of `to` that are new or changed since `from`. */
function changedOrNew<T>(from: Record<string, T>, to: Record<string, T>): string[] {
  return Object.keys(to).filter((key) => !sameJson(from[key], to[key]));
}

function dropTrigger(key: string): string {
  const [schema, rest] = splitKey(key);
  const [table, name] = splitKey(rest);
  return `DROP TRIGGER ${quoteIdent(name)} ON ${qualified(schema, table)};`;
}

/**
 * The DDL that turns the `from` snapshot into the `to` snapshot (for `denext db diff`: `from` is
 * the migrations applied to a shadow database, `to` the live one). Empty when they match.
 *
 * Order: enum types first; then what depends on tables is dropped (views, triggers, policies,
 * indexes that changed or went away); then the tables; then functions, indexes, policies, views
 * and triggers are (re)created; removed enum types go last.
 *
 * @param from The snapshot to change.
 * @param to The snapshot to reach.
 * @returns The statements.
 */
export function diffSnapshots(from: SchemaSnapshot, to: SchemaSnapshot): string[] {
  const out: string[] = [];
  diffEnums(from, to, out);
  for (const key of changedOrGone(from.views, to.views)) {
    out.push(`DROP VIEW ${qualified(...splitKey(key))};`);
  }
  for (const key of changedOrGone(from.triggers, to.triggers)) out.push(dropTrigger(key));
  for (const key of changedOrGone(from.policies, to.policies)) {
    const p = from.policies[key];
    if (to.tables[`${p.schema}.${p.table}`]) {
      out.push(`DROP POLICY ${quoteIdent(p.name)} ON ${qualified(p.schema, p.table)};`);
    }
  }
  for (const key of changedOrGone(from.indexes, to.indexes)) {
    out.push(`DROP INDEX ${qualified(...splitKey(key))};`);
  }
  diffTables(from, to, out);
  for (const key of Object.keys(from.functions).filter((k) => !(k in to.functions))) {
    out.push(dropFunction(key));
  }
  for (const key of changedOrNew(from.functions, to.functions)) out.push(`${to.functions[key]};`);
  for (const key of changedOrNew(from.indexes, to.indexes)) out.push(`${to.indexes[key]};`);
  for (const key of changedOrNew(from.policies, to.policies)) out.push(policyDef(to.policies[key]));
  for (const key of changedOrNew(from.views, to.views)) {
    out.push(`CREATE VIEW ${qualified(...splitKey(key))} AS\n${to.views[key]}`);
  }
  for (const key of changedOrNew(from.triggers, to.triggers)) out.push(`${to.triggers[key]};`);
  for (const key of Object.keys(from.enums).filter((k) => !to.enums[k])) {
    out.push(`DROP TYPE ${qualified(...splitKey(key))};`);
  }
  return out;
}
