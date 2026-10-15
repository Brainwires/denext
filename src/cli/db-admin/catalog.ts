// The catalog reads behind the Database section: tables, their columns, keys, indexes, foreign
// keys and row-level security policies, straight from `pg_catalog`. Every value is selected as
// text (or a number cast to text), so the answer is the same whichever client the project uses.
// Schema and table names arrive as `$n` parameters; the entry that comes back is the whitelist
// every later identifier is checked against (`src/ui/database/sql.ts`).

import type { SqlClient, SqlRow } from "../../server/postgres.ts";
import {
  DB_MAX_TABLES,
  type DbColumn,
  type DbPolicy,
  type DbTableInfo,
  type DbTableSummary,
} from "../../ui/database/protocol.ts";

/** `pg_class.relkind` → what the UI calls it. */
const KINDS: Record<string, string> = {
  r: "table",
  p: "partitioned",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

/** The columns every table summary selects (`c` is `pg_class`, `n` its `pg_namespace`). */
const SUMMARY_COLUMNS = `n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
  c.reltuples::bigint::text AS estimate, c.relrowsecurity::text AS rls,
  c.relforcerowsecurity::text AS forced,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)::text AS has_pk`;

/** The schemas never listed: Postgres's own. */
export const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

/** A text column as a string, or `null`. */
function text(row: SqlRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

/** A `'true'`/`'false'` text column (or a real boolean) as a boolean. */
function bool(row: SqlRow, key: string): boolean {
  const value = row[key];
  return value === true || value === "true" || value === "t";
}

/** One summary row → a {@linkcode DbTableSummary}. */
function summaryOf(row: SqlRow): DbTableSummary {
  const estimate = Number(text(row, "estimate") ?? "-1");
  return {
    schema: String(row.schema),
    name: String(row.name),
    kind: KINDS[String(row.kind)] ?? String(row.kind),
    estimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null,
    rls: bool(row, "rls"),
    forced: bool(row, "forced"),
    hasPrimaryKey: bool(row, "has_pk"),
  };
}

/**
 * Every user table, view and materialized view, by schema and name.
 *
 * @param tx The client.
 * @returns The tables (at most {@linkcode DB_MAX_TABLES}) and whether the list was cut.
 */
export async function listTables(
  tx: SqlClient,
): Promise<{ tables: DbTableSummary[]; truncated: boolean }> {
  const rows = await tx.unsafe(
    `SELECT ${SUMMARY_COLUMNS} FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${USER_SCHEMAS}
     ORDER BY n.nspname, c.relname LIMIT ${DB_MAX_TABLES + 1}`,
  );
  const tables = [...rows].map(summaryOf);
  const truncated = tables.length > DB_MAX_TABLES;
  return { tables: tables.slice(0, DB_MAX_TABLES), truncated };
}

/** `pg_attribute.attidentity` → the identity kind. */
function identityOf(code: string | null): DbColumn["identity"] {
  return code === "a" ? "always" : code === "d" ? "by default" : null;
}

/** The columns of the table with `oid`. */
async function columnsOf(tx: SqlClient, oid: string): Promise<DbColumn[]> {
  const rows = await tx.unsafe(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       format_type(a.atttypid, NULL) AS cast_type, (NOT a.attnotnull)::text AS nullable,
       pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity::text AS identity,
       (a.attgenerated <> '')::text AS generated
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid],
  );
  return [...rows].map((row) => ({
    name: String(row.name),
    type: String(row.type),
    castType: String(row.cast_type),
    nullable: bool(row, "nullable"),
    default: text(row, "default"),
    identity: identityOf(text(row, "identity")),
    generated: bool(row, "generated"),
  }));
}

/** The primary key's columns, in key order. */
async function primaryKeyOf(tx: SqlClient, oid: string): Promise<string[]> {
  const rows = await tx.unsafe(
    `SELECT a.attname AS name FROM pg_index i
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = $1::oid AND i.indisprimary ORDER BY k.ord`,
    [oid],
  );
  return [...rows].map((row) => String(row.name));
}

/** The indexes and foreign keys of the table with `oid`. */
async function indexesAndKeys(
  tx: SqlClient,
  oid: string,
): Promise<Pick<DbTableInfo, "indexes" | "foreignKeys">> {
  const indexes = await tx.unsafe(
    `SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = $1::oid ORDER BY ic.relname`,
    [oid],
  );
  const keys = await tx.unsafe(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = $1::oid AND contype = 'f' ORDER BY conname`,
    [oid],
  );
  const pair = (row: SqlRow) => ({ name: String(row.name), definition: String(row.definition) });
  return { indexes: [...indexes].map(pair), foreignKeys: [...keys].map(pair) };
}

/** One `pg_policies` row → a {@linkcode DbPolicy}. */
function policyOf(row: SqlRow): DbPolicy {
  return {
    schema: String(row.schemaname),
    table: String(row.tablename),
    name: String(row.policyname),
    permissive: String(row.permissive),
    roles: String(row.roles),
    command: String(row.cmd),
    using: text(row, "qual"),
    check: text(row, "with_check"),
  };
}

/** The columns `pg_policies` is read with. */
const POLICY_COLUMNS =
  "schemaname, tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check";

/**
 * Every row-level security policy, or one table's.
 *
 * @param tx The client.
 * @param table Only this table's.
 * @returns The policies.
 */
export async function listPolicies(
  tx: SqlClient,
  table?: { schema: string; name: string },
): Promise<DbPolicy[]> {
  const rows = table
    ? await tx.unsafe(
      `SELECT ${POLICY_COLUMNS} FROM pg_policies WHERE schemaname = $1 AND tablename = $2
       ORDER BY policyname`,
      [table.schema, table.name],
    )
    : await tx.unsafe(
      `SELECT ${POLICY_COLUMNS} FROM pg_policies ORDER BY schemaname, tablename, policyname
       LIMIT 2000`,
    );
  return [...rows].map(policyOf);
}

/**
 * One table's catalog entry, or `null` when there is no such table.
 *
 * @param tx The client.
 * @param schema Its schema.
 * @param name Its name.
 * @returns The entry.
 */
export async function tableInfo(
  tx: SqlClient,
  schema: string,
  name: string,
): Promise<DbTableInfo | null> {
  if (typeof schema !== "string" || typeof name !== "string") return null;
  const [row] = await tx.unsafe(
    `SELECT c.oid::text AS oid, ${SUMMARY_COLUMNS}
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND ${USER_SCHEMAS}`,
    [schema, name],
  );
  if (!row) return null;
  const oid = String(row.oid);
  return {
    ...summaryOf(row),
    columns: await columnsOf(tx, oid),
    primaryKey: await primaryKeyOf(tx, oid),
    ...await indexesAndKeys(tx, oid),
    policies: await listPolicies(tx, { schema, name }),
  };
}

/**
 * The schema holding denext auth's tables (`auth_users`), preferring one on the search path,
 * and which of the auth tables it has.
 *
 * @param tx The client.
 * @returns The schema and its auth tables, or `null` when there is no `auth_users`.
 */
export async function authTables(
  tx: SqlClient,
): Promise<{ schema: string; tables: Set<string> } | null> {
  const [found] = await tx.unsafe(
    `SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'auth_users' AND c.relkind IN ('r', 'p') AND ${USER_SCHEMAS}
     ORDER BY (n.nspname = ANY (current_schemas(false))) DESC, n.nspname LIMIT 1`,
  );
  if (!found) return null;
  const schema = String(found.schema);
  const rows = await tx.unsafe(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname LIKE 'auth\\_%' AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  return { schema, tables: new Set([...rows].map((row) => String(row.name))) };
}
