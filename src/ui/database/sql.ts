// The SQL the Database section sends, built in one place so it can be read, tested and shown.
//
// Two rules hold for every statement here:
//
//   1. An identifier (schema, table, column) is never taken from a request as text. It is looked
//      up in the table's catalog entry ({@linkcode DbTableInfo}, read from `pg_catalog`), and only
//      a name found there is quoted ({@linkcode quoteIdent}) into the SQL. A name the catalog does
//      not list is a `DbSqlError`, not a statement.
//   2. A value is never spliced into the text. Each is a `$n` parameter sent as text and cast to
//      its column's type in the SQL (`$1::integer`), so Postgres parses it — what a user typed in
//      a cell is a value however it is spelled.
//
// Paging is keyset, never OFFSET: a page is the rows after the previous page's last row, compared
// on the primary key (and on the sort column first, when one is chosen).

import {
  DB_CELL_MAX_CHARS,
  DB_CELL_PREVIEW_CHARS,
  DB_PAGE_ROWS,
  type DbColumn,
  type DbStatement,
  type DbTableInfo,
} from "./protocol.ts";

/** A request named something the catalog does not have, or asked for an impossible write. */
export class DbSqlError extends Error {
  /**
   * Build the error.
   *
   * @param message What was wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "DbSqlError";
  }
}

/**
 * Quote an identifier: wrapped in double quotes, each embedded quote doubled. Callers pass only
 * names the catalog returned.
 *
 * @param name The identifier.
 * @returns The quoted identifier.
 * @throws {DbSqlError} For an empty name or one carrying a NUL.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || name === "" || name.includes("\0")) {
    throw new DbSqlError("not an identifier");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A table's schema-qualified, quoted name.
 *
 * @param table The catalog entry.
 * @returns `"schema"."name"`.
 */
export function qualifiedName(table: { schema: string; name: string }): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/**
 * A column of `table`, by name — the whitelist every identifier passes through.
 *
 * @param table The catalog entry.
 * @param name The requested column.
 * @returns The column.
 * @throws {DbSqlError} When the table has no such column.
 */
export function columnOf(table: DbTableInfo, name: string): DbColumn {
  const column = table.columns.find((c) => c.name === name);
  if (!column) throw new DbSqlError(`${table.name} has no column ${JSON.stringify(name)}`);
  return column;
}

/** Collects `$n` parameters as a statement is built. */
class Params {
  readonly values: (string | null)[] = [];

  /**
   * Bind a value cast to `column`'s type.
   *
   * @param column The column the value is for.
   * @param value The value as text (`null` binds NULL).
   * @returns The placeholder, cast (`$3::integer`).
   */
  bind(column: DbColumn, value: string | null): string {
    this.values.push(value);
    return `$${this.values.length}::${column.castType}`;
  }
}

/** Options for {@linkcode selectPage}. */
export interface PageOptions {
  /** Sort by this column first (the primary key breaks ties); default: the primary key. */
  readonly sort?: string;
  /** Sort direction (default ascending). */
  readonly direction?: "asc" | "desc";
  /** The previous page's cursor: the sort column's value (when sorting), then the key's. */
  readonly after?: readonly (string | null)[];
  /** A `column = value` filter (`value: null` is `IS NULL`). */
  readonly filter?: { readonly column: string; readonly value: string | null };
  /** Rows per page (default {@linkcode DB_PAGE_ROWS}); one more is read to tell if there is a next. */
  readonly limit?: number;
}

/**
 * Every column, as text — a value round-trips through its text form (and survives JSON). A
 * column not in `whole` is cut to `cap` characters in SQL, so a table of large values does not
 * ship them all to show a page: the key and sort columns stay whole (a cursor is built from
 * them), and a cut value comes back one character longer than the cap so the caller can tell.
 */
function selectList(table: DbTableInfo, cap: number, whole: ReadonlySet<string>): string {
  return table.columns.map((c) => {
    const value = `${quoteIdent(c.name)}::text`;
    const shown = whole.has(c.name) ? value : `left(${value}, ${cap + 1})`;
    return `${shown} AS ${quoteIdent(c.name)}`;
  }).join(", ");
}

/** `("a", "b")` for the key columns. */
function keyTuple(columns: readonly DbColumn[]): string {
  return `(${columns.map((c) => quoteIdent(c.name)).join(", ")})`;
}

/** The ordering a page is read in: the sort column, if any, then the primary key. */
interface Ordering {
  readonly sort: DbColumn | null;
  readonly key: readonly DbColumn[];
  readonly op: ">" | "<";
  readonly direction: "ASC" | "DESC";
}

/** Resolve the ordering against the catalog. */
function orderingOf(table: DbTableInfo, options: PageOptions): Ordering {
  const key = table.primaryKey.map((name) => columnOf(table, name));
  let sort = options.sort ? columnOf(table, options.sort) : null;
  // Sorting by the sole key column IS key order.
  if (sort && key.length === 1 && key[0].name === sort.name) sort = null;
  const desc = options.direction === "desc";
  return { sort, key, op: desc ? "<" : ">", direction: desc ? "DESC" : "ASC" };
}

/** The keyset condition for the rows after `after`, or `null` on the first page. */
function keysetCondition(
  order: Ordering,
  after: readonly (string | null)[] | undefined,
  params: Params,
): string | null {
  if (!after) return null;
  if (order.key.length === 0) throw new DbSqlError("this table has no primary key to page by");
  const expected = order.key.length + (order.sort ? 1 : 0);
  if (after.length !== expected) throw new DbSqlError("the page cursor does not fit this table");
  const keyValues = after.slice(order.sort ? 1 : 0);
  if (keyValues.some((v) => v === null)) throw new DbSqlError("a primary key value is never NULL");
  const keyParams = `(${order.key.map((c, i) => params.bind(c, keyValues[i])).join(", ")})`;
  const keyAfter = `${keyTuple(order.key)} ${order.op} ${keyParams}`;
  if (!order.sort) return keyAfter;
  const col = quoteIdent(order.sort.name);
  const sortValue = after[0];
  // NULLs sort last in both directions: past the non-NULL values, then by key among the NULLs.
  if (sortValue === null) return `(${col} IS NULL AND ${keyAfter})`;
  const p = params.bind(order.sort, sortValue);
  return `(${col} ${order.op} ${p} OR (${col} = ${p} AND ${keyAfter}) OR ${col} IS NULL)`;
}

/**
 * The ORDER BY clause, or `""` for a table with no key and no sort. Each column is qualified by
 * the table: a bare name in ORDER BY means the OUTPUT column first, and the select list re-names
 * every column to its `::text` form — so `ORDER BY "id"` would sort a bigint key as text.
 */
function orderBy(table: DbTableInfo, order: Ordering): string {
  const ref = (c: DbColumn) => `${qualifiedName(table)}.${quoteIdent(c.name)}`;
  const terms = [
    ...(order.sort ? [`${ref(order.sort)} ${order.direction} NULLS LAST`] : []),
    ...order.key.map((c) => `${ref(c)} ${order.direction}`),
  ];
  return terms.length ? ` ORDER BY ${terms.join(", ")}` : "";
}

/** A validated page size. */
function pageLimit(limit: number | undefined): number {
  const n = limit ?? DB_PAGE_ROWS;
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new DbSqlError("bad page size");
  return n;
}

/**
 * One page of rows, keyset-paged: every column as text, filtered, ordered by the sort column
 * (NULLs last) and then the primary key, reading one row more than a page so the caller can tell
 * whether there is a next one.
 *
 * @param table The catalog entry.
 * @param options Sort, direction, cursor, filter and page size.
 * @returns The statement.
 * @throws {DbSqlError} For a column the table does not have, or a cursor that does not fit.
 */
export function selectPage(table: DbTableInfo, options: PageOptions = {}): DbStatement {
  const params = new Params();
  const order = orderingOf(table, options);
  const where: string[] = [];
  if (options.filter) {
    const column = columnOf(table, options.filter.column);
    where.push(
      options.filter.value === null
        ? `${quoteIdent(column.name)} IS NULL`
        : `${quoteIdent(column.name)} = ${params.bind(column, options.filter.value)}`,
    );
  }
  const keyset = keysetCondition(order, options.after, params);
  if (keyset) where.push(keyset);
  const whole = new Set([...table.primaryKey, ...(options.sort ? [options.sort] : [])]);
  const text =
    `SELECT ${selectList(table, DB_CELL_PREVIEW_CHARS, whole)} FROM ${qualifiedName(table)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    orderBy(table, order) +
    ` LIMIT ${pageLimit(options.limit) + 1}`;
  return { text, params: params.values };
}

/**
 * The cursor that continues after `row`: its sort-column value (when sorting), then its key.
 *
 * @param table The catalog entry.
 * @param row The last row of a page (every value as text).
 * @param sort The sort column, as the page was read.
 * @returns The cursor.
 */
export function cursorAfter(
  table: DbTableInfo,
  row: Record<string, string | null>,
  sort?: string,
): (string | null)[] {
  const order = orderingOf(table, { sort });
  return [
    ...(order.sort ? [row[order.sort.name] ?? null] : []),
    ...order.key.map((c) => row[c.name] ?? null),
  ];
}

/** The `WHERE` matching exactly the row with `key` (every key column required). */
function keyMatch(
  table: DbTableInfo,
  key: Readonly<Record<string, string>>,
  params: Params,
): string {
  if (table.primaryKey.length === 0) {
    throw new DbSqlError(`${table.name} has no primary key, so a row cannot be addressed`);
  }
  const names = Object.keys(key);
  if (
    names.length !== table.primaryKey.length || names.some((n) => !table.primaryKey.includes(n))
  ) {
    throw new DbSqlError("the row key must name exactly the primary key's columns");
  }
  return table.primaryKey
    .map((name) => {
      const column = columnOf(table, name);
      const value = key[name];
      if (typeof value !== "string") throw new DbSqlError("a key value must be text");
      return `${quoteIdent(name)} = ${params.bind(column, value)}`;
    })
    .join(" AND ");
}

/** `RETURNING` the key, so the caller counts exactly the rows the statement touched. */
function returningKey(table: DbTableInfo): string {
  return ` RETURNING ${table.primaryKey.map((n) => `${quoteIdent(n)}::text`).join(", ")}`;
}

/**
 * The row with `key`, every column as text.
 *
 * @param table The catalog entry.
 * @param key The primary key's values.
 * @returns The statement.
 */
export function selectRow(table: DbTableInfo, key: Readonly<Record<string, string>>): DbStatement {
  const params = new Params();
  const match = keyMatch(table, key, params);
  return {
    text: `SELECT ${selectList(table, DB_CELL_MAX_CHARS, new Set(table.primaryKey))} FROM ${
      qualifiedName(table)
    } WHERE ${match} LIMIT 1`,
    params: params.values,
  };
}

/** Writes go to plain (or partitioned) tables with a primary key only. */
function assertWritable(table: DbTableInfo): void {
  if (table.kind !== "table" && table.kind !== "partitioned") {
    throw new DbSqlError(`${table.name} is a ${table.kind}: only tables are edited here`);
  }
  if (table.primaryKey.length === 0) {
    throw new DbSqlError(`${table.name} has no primary key: it is shown read-only`);
  }
}

/** A column a write may set: not generated, not `GENERATED ALWAYS AS IDENTITY`. */
function assertSettable(column: DbColumn): void {
  if (column.generated) throw new DbSqlError(`${column.name} is a generated column`);
  if (column.identity === "always") {
    throw new DbSqlError(`${column.name} is an identity column (GENERATED ALWAYS)`);
  }
}

/** Refuse an over-long value before it becomes a parameter. */
function checkValue(value: string | null, max: number): void {
  if (value !== null && (typeof value !== "string" || value.length > max)) {
    throw new DbSqlError(`a value is longer than ${max} characters`);
  }
}

/**
 * Set one or more columns of the row with `key`.
 *
 * @param table The catalog entry.
 * @param key The primary key's values.
 * @param values Column → new value (`null` sets NULL).
 * @param maxValue The longest value accepted.
 * @returns The statement (`RETURNING` the key, so exactly one row must come back).
 */
export function updateRow(
  table: DbTableInfo,
  key: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string | null>>,
  maxValue: number,
): DbStatement {
  assertWritable(table);
  const names = Object.keys(values);
  if (names.length === 0) throw new DbSqlError("nothing to update");
  const params = new Params();
  const sets = names.map((name) => {
    const column = columnOf(table, name);
    assertSettable(column);
    checkValue(values[name], maxValue);
    return `${quoteIdent(name)} = ${params.bind(column, values[name])}`;
  });
  const match = keyMatch(table, key, params);
  return {
    text: `UPDATE ${qualifiedName(table)} SET ${sets.join(", ")} WHERE ${match}` +
      returningKey(table),
    params: params.values,
  };
}

/**
 * Insert one row. Columns left out take their default.
 *
 * @param table The catalog entry.
 * @param values Column → value (`null` inserts NULL).
 * @param maxValue The longest value accepted.
 * @returns The statement.
 */
export function insertRow(
  table: DbTableInfo,
  values: Readonly<Record<string, string | null>>,
  maxValue: number,
): DbStatement {
  assertWritable(table);
  const params = new Params();
  const names = Object.keys(values);
  const placeholders = names.map((name) => {
    const column = columnOf(table, name);
    assertSettable(column);
    checkValue(values[name], maxValue);
    return params.bind(column, values[name]);
  });
  const body = names.length
    ? `(${names.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")})`
    : "DEFAULT VALUES";
  return {
    text: `INSERT INTO ${qualifiedName(table)} ${body}${returningKey(table)}`,
    params: params.values,
  };
}

/**
 * Delete the row with `key`.
 *
 * @param table The catalog entry.
 * @param key The primary key's values.
 * @returns The statement.
 */
export function deleteRow(table: DbTableInfo, key: Readonly<Record<string, string>>): DbStatement {
  assertWritable(table);
  const params = new Params();
  const match = keyMatch(table, key, params);
  return {
    text: `DELETE FROM ${qualifiedName(table)} WHERE ${match}${returningKey(table)}`,
    params: params.values,
  };
}

/**
 * The migration that turns row-level security on for a table: the `ALTER TABLE`, and a
 * commented-out example policy in the Supabase style (`auth.uid()`), since a table with RLS on
 * and no policy shows its rows to nobody but its owner.
 *
 * @param table The table (from the catalog).
 * @returns The migration's SQL.
 */
export function enableRlsMigration(table: { schema: string; name: string }): string {
  const name = qualifiedName(table);
  return `-- Row-level security for ${name}.
-- With RLS on and no policy, only the table's owner (and roles with BYPASSRLS) see its rows.
-- Add the policies your app needs, for example (\`auth.uid()\` comes with @denext/backend):
--
--   CREATE POLICY "owner can read" ON ${name}
--     FOR SELECT TO authenticated USING (auth.uid() = owner_id);
ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;
`;
}
