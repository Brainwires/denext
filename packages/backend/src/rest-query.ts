// The auto-REST query builder: a PostgREST-style request (`?select=a,b&age=gte.18&order=a.desc`)
// becomes ONE statement over the catalog's table. Two rules hold for every statement:
//
//   1. An identifier is never taken from the request as text: the table and each column are
//      looked up in the catalog (`rest-catalog.ts`) and only a name found there is quoted into
//      the SQL. A name the catalog does not list is a 400, not a statement. Operators, sort
//      directions and `is` values come from fixed tables here.
//   2. A value is never spliced into the text. Each filter value is a `$n` parameter sent as
//      text and cast to its column's type (`$1::integer`); a request body is ONE `$n::json`
//      parameter expanded by `json_populate_record(set)` against the table's own row type —
//      Postgres parses every value, however it is spelled.
//
// The rows come back as one JSON text built by Postgres (`json_agg`), so a `bigint` or a
// `numeric` keeps its digits and every driver answers the same.

import type { RestColumn, RestTable } from "./rest-catalog.ts";

/** A refused request, answered with a PostgREST-shaped JSON error. */
export class RestError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** A PostgREST-style code (`PGRST100`) or a Postgres SQLSTATE (`42703`). */
  readonly code: string;
  /** More detail, if any. */
  readonly details: string | null;
  /** How to fix it, if known. */
  readonly hint: string | null;

  /**
   * Build the error.
   *
   * @param status The HTTP status.
   * @param code The code.
   * @param message What went wrong.
   * @param details More detail.
   * @param hint How to fix it.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    details: string | null = null,
    hint: string | null = null,
  ) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

/** A statement and its parameters, every one sent as text. */
export interface RestStatement {
  /** The SQL. */
  readonly text: string;
  /** The `$n` values, in order. */
  readonly params: string[];
}

/** The most values one `in.(…)` filter takes. */
export const MAX_IN_VALUES = 1000;
/** The most filters one request takes. */
const MAX_FILTERS = 64;
/** Query parameters that are not column filters. */
const RESERVED = new Set(["select", "order", "limit", "offset"]);
/** PostgREST parameters this implementation does not offer (refused, never read as a column). */
const UNSUPPORTED = new Set(["or", "and", "on_conflict", "columns"]);

/** The comparison operators, each to its SQL. */
const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** `is.<value>` → SQL. */
const IS_VALUES: Record<string, string> = {
  null: "NULL",
  true: "TRUE",
  false: "FALSE",
  unknown: "UNKNOWN",
};

/** A request-supplied name, shortened for an error message. */
function shown(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}

/** A malformed request. */
function parseError(message: string, hint: string | null = null): RestError {
  return new RestError(400, "PGRST100", message, null, hint);
}

/**
 * Quote an identifier the catalog returned: double quotes, each embedded quote doubled.
 *
 * @param name The identifier.
 * @returns The quoted identifier.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The table's schema-qualified, quoted name. */
function qualified(table: RestTable): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/**
 * A column of `table`, by name — the whitelist every column identifier passes through.
 *
 * @param table The catalog entry.
 * @param name The requested column.
 * @returns The column.
 * @throws {RestError} `42703` (400) when the table has no such column.
 */
export function columnOf(table: RestTable, name: string): RestColumn {
  const column = table.columns.find((c) => c.name === name);
  if (!column) {
    throw new RestError(400, "42703", `column ${table.name}.${shown(name)} does not exist`);
  }
  return column;
}

/** Collects `$n` parameters as a statement is built. */
class Params {
  readonly values: string[] = [];

  /** Bind a value as text, cast to `type` (a catalog type name, never request text). */
  bind(type: string, value: string): string {
    this.values.push(value);
    return `$${this.values.length}::${type}`;
  }
}

/** One in-list item: `"quoted"` (`\"` and `\\` escapes) or bare, up to a comma or the end. */
const IN_ITEM = /"((?:[^"\\]|\\.)*)"(?=,|$)|([^,"]*)(?=,|$)/y;

/** Split an `in.(…)` list: comma-separated, `"quoted, items"` with `\"` and `\\` escapes. */
export function parseInList(raw: string): string[] {
  if (!raw.startsWith("(") || !raw.endsWith(")")) {
    throw parseError("an in filter takes a list: in.(a,b,c)");
  }
  const body = raw.slice(1, -1);
  if (body === "") return [];
  const items: string[] = [];
  for (let at = 0; at <= body.length; at = IN_ITEM.lastIndex + 1) {
    IN_ITEM.lastIndex = at;
    const match = IN_ITEM.exec(body);
    if (!match) throw parseError("a malformed in-list: quote an item holding a comma or a quote");
    items.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
    if (items.length > MAX_IN_VALUES) {
      throw parseError(`an in filter takes at most ${MAX_IN_VALUES} values`);
    }
  }
  return items;
}

/** Builds one operator's condition from the quoted column, the column and the value. */
type Operator = (ref: string, column: RestColumn, value: string, params: Params) => string;

/** A pattern operator: `*` is PostgREST's URL-friendly spelling of `%`. */
const pattern = (sql: string): Operator => (ref, _column, value, params) =>
  `${ref} ${sql} ${params.bind("text", value.replaceAll("*", "%"))}`;

/** Every operator, by name. */
const OPERATORS: Record<string, Operator> = {
  ...Object.fromEntries(
    Object.entries(COMPARISONS).map(([op, sql]): [string, Operator] => [
      op,
      (ref, column, value, params) => `${ref} ${sql} ${params.bind(column.castType, value)}`,
    ]),
  ),
  like: pattern("LIKE"),
  ilike: pattern("ILIKE"),
  is: (ref, _column, value) => {
    const keyword = value.toLowerCase();
    if (!Object.hasOwn(IS_VALUES, keyword)) {
      throw parseError("is takes null, true, false or unknown");
    }
    return `${ref} IS ${IS_VALUES[keyword]}`;
  },
  in: (ref, column, value, params) => {
    const items = parseInList(value);
    if (items.length === 0) return "FALSE";
    return `${ref} IN (${items.map((item) => params.bind(column.castType, item)).join(", ")})`;
  },
};

/** `[not.]op.value`. */
const FILTER = /^(not\.)?([a-z]+)\.(.*)$/s;

/** One `column=op.value` filter → a condition. */
function filterOf(table: RestTable, key: string, raw: string, params: Params): string {
  const column = columnOf(table, key);
  const match = FILTER.exec(raw);
  if (!match) throw parseError(`filter ${shown(key)} needs an operator: ${key}=eq.value`);
  const [, negate, op, value] = match;
  if (!Object.hasOwn(OPERATORS, op)) {
    throw parseError(
      `unknown operator ${shown(op)}`,
      "use eq, neq, gt, gte, lt, lte, like, ilike, is or in (each may follow not.)",
    );
  }
  const condition = OPERATORS[op](quoteIdent(column.name), column, value, params);
  return negate ? `NOT (${condition})` : condition;
}

/**
 * The `WHERE` clause for every column filter in `query` (`""` when there is none), and how many
 * filters it has.
 */
function whereOf(
  table: RestTable,
  query: URLSearchParams,
  params: Params,
): { clause: string; count: number } {
  const conditions: string[] = [];
  for (const [key, value] of query) {
    if (RESERVED.has(key)) continue;
    if (UNSUPPORTED.has(key)) {
      throw parseError(`${shown(key)} is not supported by this REST endpoint`);
    }
    if (conditions.length === MAX_FILTERS) {
      throw parseError(`a request takes at most ${MAX_FILTERS} filters`);
    }
    conditions.push(filterOf(table, key, value, params));
  }
  return {
    clause: conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "",
    count: conditions.length,
  };
}

/**
 * The select list for `select=a,b` (`*` when absent). Columns only: an embedded resource, an
 * alias, a cast or a JSON path is refused.
 *
 * @param table The catalog entry.
 * @param raw The `select` parameter.
 * @returns The SQL select list.
 */
export function selectListOf(table: RestTable, raw: string | null): string {
  if (raw === null || raw.trim() === "" || raw.trim() === "*") return "*";
  return raw.split(",").map((item) => {
    const name = item.trim();
    if (name === "*") return "*";
    if (name.includes("(")) {
      throw parseError(
        "embedded resources are not supported",
        "select columns of this table only, and read related rows with a second request",
      );
    }
    if (/:|->/.test(name)) {
      throw parseError("aliases, casts and JSON paths are not supported in select");
    }
    return quoteIdent(columnOf(table, name).name);
  }).join(", ");
}

/** One `order` term: a column, then optionally a direction, then optionally where NULLs go. */
const ORDER_TERM = /^([^.]+)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/;

/** `order=a.desc.nullslast,b` → the ORDER BY clause (`""` when absent). */
function orderOf(table: RestTable, raw: string | null): string {
  if (raw === null || raw.trim() === "") return "";
  const terms = raw.split(",").map((item) => {
    const match = ORDER_TERM.exec(item.trim());
    if (!match) {
      throw parseError(
        `bad order term ${shown(item)}`,
        "order=column.asc|desc.nullsfirst|nullslast",
      );
    }
    const [, name, direction, nulls] = match;
    return quoteIdent(columnOf(table, name).name) +
      (direction ? ` ${direction.toUpperCase()}` : "") +
      (nulls ? (nulls === "nullsfirst" ? " NULLS FIRST" : " NULLS LAST") : "");
  });
  return ` ORDER BY ${terms.join(", ")}`;
}

/** A non-negative integer query parameter, or `undefined` when absent. */
export function countParam(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw parseError(`${name} must be a non-negative integer`);
  return Number(raw);
}

/** Options for {@linkcode buildSelect}. */
export interface SelectOptions {
  /** Rows to skip. */
  readonly offset: number;
  /** Rows to return (already capped at `maxRows`). */
  readonly limit: number;
  /** Also count every matching row (`Prefer: count=exact`). */
  readonly count: boolean;
}

/**
 * A read: `{ body, n[, total] }` — the page as one JSON array text, its row count, and (with
 * `count`) every matching row's count.
 *
 * @param table The catalog entry.
 * @param query The request's query.
 * @param options Paging and counting.
 * @returns The statement.
 * @throws {RestError} For an unknown column, operator or modifier.
 */
export function buildSelect(
  table: RestTable,
  query: URLSearchParams,
  options: SelectOptions,
): RestStatement {
  const params = new Params();
  const select = selectListOf(table, query.get("select"));
  const { clause } = whereOf(table, query, params);
  const order = orderOf(table, query.get("order"));
  const from = qualified(table);
  const total = options.count ? `, (SELECT count(*) FROM ${from}${clause})::text AS total` : "";
  const page = `SELECT ${select} FROM ${from}${clause}${order} LIMIT ${options.limit}` +
    (options.offset ? ` OFFSET ${options.offset}` : "");
  return {
    text: `SELECT coalesce(json_agg(_r), '[]')::text AS body, count(*)::text AS n${total} ` +
      `FROM (${page}) _r`,
    params: params.values,
  };
}

/** A body's object, or a refusal. */
function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RestError(400, "PGRST102", "the body must be a JSON object or an array of objects");
  }
  return value as Record<string, unknown>;
}

/** The columns a write sets: each in the catalog, none generated or `GENERATED ALWAYS`. */
function writableColumns(table: RestTable, names: readonly string[]): RestColumn[] {
  return names.map((name) => {
    const column = columnOf(table, name);
    if (column.readOnly) {
      throw new RestError(
        400,
        "428C9",
        `cannot write column ${shown(name)}: it is generated`,
      );
    }
    return column;
  });
}

/** Wrap a write: `RETURNING` the select list as `{ body, n }`, or the bare statement. */
function returning(statement: string, select: string | null): string {
  if (select === null) return statement;
  return `WITH _m AS (${statement} RETURNING ${select}) ` +
    `SELECT coalesce(json_agg(_m), '[]')::text AS body, count(*)::text AS n FROM _m`;
}

/** Options for a write. */
export interface WriteOptions {
  /** Answer with the written rows (`Prefer: return=representation`), as `select=` lists them. */
  readonly representation: boolean;
}

/**
 * An insert of one object or an array of objects (every object with the same keys), expanded
 * from one `$1::json` parameter by `json_populate_record(set)` over the table's row type.
 * Columns left out take their default.
 *
 * @param table The catalog entry.
 * @param query The request's query (`select=` shapes a representation).
 * @param body The parsed JSON body.
 * @param options Representation or not.
 * @returns The statement.
 * @throws {RestError} For a body that is not an object (or array of them), mismatched keys, or
 *   an unknown or generated column.
 */
export function buildInsert(
  table: RestTable,
  query: URLSearchParams,
  body: unknown,
  options: WriteOptions,
): RestStatement {
  const rows = Array.isArray(body) ? body.map(objectOf) : [objectOf(body)];
  if (rows.length === 0) {
    throw new RestError(400, "PGRST102", "the body is an empty array: nothing to insert");
  }
  const names = Object.keys(rows[0]);
  const key = [...names].sort().join("\0");
  if (rows.some((row) => Object.keys(row).sort().join("\0") !== key)) {
    throw new RestError(400, "PGRST102", "all objects must have the same keys");
  }
  const columns = writableColumns(table, names);
  const select = options.representation ? selectListOf(table, query.get("select")) : null;
  const target = qualified(table);
  if (columns.length === 0) {
    if (rows.length > 1) {
      throw new RestError(
        400,
        "PGRST102",
        "objects without keys can only be inserted one at a time",
      );
    }
    return { text: returning(`INSERT INTO ${target} DEFAULT VALUES`, select), params: [] };
  }
  const params = new Params();
  const json = params.bind("json", JSON.stringify(Array.isArray(body) ? rows : rows[0]));
  const source = Array.isArray(body) ? "json_populate_recordset" : "json_populate_record";
  const list = columns.map((c) => quoteIdent(c.name)).join(", ");
  const insert =
    `INSERT INTO ${target} (${list}) SELECT ${list} FROM ${source}(NULL::${target}, ${json})`;
  return { text: returning(insert, select), params: params.values };
}

/** Refuse a PATCH / DELETE that would touch every row. */
function requireFilter(count: number, verb: "UPDATE" | "DELETE"): void {
  if (count === 0) {
    throw new RestError(
      400,
      "21000",
      `${verb} requires a WHERE clause`,
      null,
      "add a filter (?id=eq.1); to change every row, filter on a column every row matches",
    );
  }
}

/**
 * An update of the rows matching the filters, setting the body's columns from one `$1::json`
 * parameter. A request without a filter is refused.
 *
 * @param table The catalog entry.
 * @param query The request's query: the filters (required) and `select=`.
 * @param body The parsed JSON body: one object with at least one key.
 * @param options Representation or not.
 * @returns The statement.
 * @throws {RestError} With no filter, an empty or non-object body, or an unknown column.
 */
export function buildUpdate(
  table: RestTable,
  query: URLSearchParams,
  body: unknown,
  options: WriteOptions,
): RestStatement {
  if (Array.isArray(body)) {
    throw new RestError(400, "PGRST102", "an update takes one JSON object, not an array");
  }
  const values = objectOf(body);
  const columns = writableColumns(table, Object.keys(values));
  if (columns.length === 0) throw new RestError(400, "PGRST102", "nothing to update");
  const params = new Params();
  const json = params.bind("json", JSON.stringify(values));
  const { clause, count } = whereOf(table, query, params);
  requireFilter(count, "UPDATE");
  const select = options.representation ? selectListOf(table, query.get("select")) : null;
  const target = qualified(table);
  const list = columns.map((c) => quoteIdent(c.name)).join(", ");
  const update = `UPDATE ${target} SET (${list}) = ` +
    `(SELECT ${list} FROM json_populate_record(NULL::${target}, ${json}))${clause}`;
  return { text: returning(update, select), params: params.values };
}

/**
 * A delete of the rows matching the filters. A request without a filter is refused.
 *
 * @param table The catalog entry.
 * @param query The request's query: the filters (required) and `select=`.
 * @param options Representation or not.
 * @returns The statement.
 * @throws {RestError} With no filter, or an unknown column or operator.
 */
export function buildDelete(
  table: RestTable,
  query: URLSearchParams,
  options: WriteOptions,
): RestStatement {
  const params = new Params();
  const { clause, count } = whereOf(table, query, params);
  requireFilter(count, "DELETE");
  const select = options.representation ? selectListOf(table, query.get("select")) : null;
  return {
    text: returning(`DELETE FROM ${qualified(table)}${clause}`, select),
    params: params.values,
  };
}
