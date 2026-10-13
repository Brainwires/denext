// The auto-REST query builder: a PostgREST-style request (`?select=a,b,author(name)&age=gte.18
// &or=(x.eq.1,y.is.null)&order=a.desc`) becomes ONE statement. Two rules hold for every one:
//
//   1. An identifier is never taken from the request as text: the relation, each column, each
//      embedded relation (through the catalog's foreign keys), each function and argument, and
//      each `::cast` type are looked up in the catalog (`rest-catalog.ts`) and only a name found
//      there is quoted into the SQL. A name the catalog does not list is a 400, not a statement.
//      Operators, sort directions and `is` values come from fixed tables here.
//   2. A value is never spliced into the text. Each filter value and each JSON-path key is a `$n`
//      parameter sent as text and cast to its column's type (`$1::integer`); a request body is
//      ONE `$n::json` parameter expanded by `json_populate_recordset` against the table's own row
//      type (or `json_to_record` against a function's argument types) — Postgres parses every
//      value, however it is spelled.
//
// Embedded resources are `LEFT JOIN LATERAL` subqueries correlated on the foreign key's columns,
// aggregated with `json_agg` (to-many) or `row_to_json` (to-one); `!inner` and `rel=not.is.null`
// keep only the parent rows that have a match. The rows come back as one JSON text built by
// Postgres (`json_agg`), so a `bigint` or a `numeric` keeps its digits and every driver answers
// the same.

import type {
  RestCatalog,
  RestColumn,
  RestFunction,
  RestFunctionArg,
  RestRelationName,
  RestTable,
} from "./rest-catalog.ts";
import {
  type Condition,
  type FieldRef,
  type FilterValue,
  MAX_DEPTH,
  type OrderTerm,
  parseError,
  parseField,
  parseFilterValue,
  parseInList,
  parseLogic,
  parseOrder,
  RestError,
  type SelectEmbed,
  type SelectItem,
  shown,
} from "./rest-parse.ts";
import { type Relationship, resolveRelationship } from "./rest-relations.ts";

export { MAX_IN_VALUES, parseInList, RestError } from "./rest-parse.ts";

/** A statement and its parameters, every one sent as text. */
export interface RestStatement {
  /** The SQL. */
  readonly text: string;
  /** The `$n` values, in order. */
  readonly params: string[];
}

/** The most filters one request takes (each leaf of a logic tree counts). */
const MAX_FILTERS = 64;
/** The most parameters one statement binds (Postgres's own limit is 65535). */
const MAX_PARAMS = 30_000;
/** The most rows one `missing=default` insert takes (one parameter per row). */
const MAX_DEFAULT_ROWS = 10_000;

/**
 * Quote an identifier the catalog returned: double quotes, each embedded quote doubled.
 *
 * @param name The identifier.
 * @returns The quoted identifier.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A relation's schema-qualified, quoted name.
 *
 * @param rel The relation.
 * @returns `"schema"."name"`.
 */
function qualified(rel: RestRelationName): string {
  return `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`;
}

/** What a query reads from: a table or view, or a function's result rows. */
export interface QuerySource {
  /** The schema. */
  readonly schema: string;
  /** The name (a relation's, or a function's). */
  readonly name: string;
  /** The columns. */
  readonly columns: readonly RestColumn[];
  /** The relation whose foreign keys embeds follow (`undefined`: none). */
  readonly relation?: RestRelationName;
}

/**
 * A table as a query source.
 *
 * @param table The catalog entry.
 * @returns The source.
 */
export function tableSource(table: RestTable): QuerySource {
  return { schema: table.schema, name: table.name, columns: table.columns, relation: table };
}

/**
 * A column of `source`, by name — the whitelist every column identifier passes through.
 *
 * @param source The relation (or function result).
 * @param name The requested column.
 * @returns The column.
 * @throws {RestError} `42703` (400) when there is no such column.
 */
export function columnOf(source: { name: string; columns: readonly RestColumn[] }, name: string) {
  const column = source.columns.find((c) => c.name === name);
  if (!column) {
    throw new RestError(400, "42703", `column ${source.name}.${shown(name)} does not exist`);
  }
  return column;
}

/** Collects `$n` parameters as a statement is built. */
class Params {
  readonly values: string[] = [];

  /** Bind a value as text, cast to `type` (catalog SQL, never request text). */
  bind(type: string, value: string): string {
    if (this.values.length >= MAX_PARAMS) {
      throw parseError(`a request binds at most ${MAX_PARAMS} values`);
    }
    this.values.push(value);
    return `$${this.values.length}::${type}`;
  }
}

/** One statement being built: its parameters, its aliases, and the catalog. */
class Sql {
  readonly params = new Params();
  #next = 0;

  constructor(readonly catalog: RestCatalog) {}

  /** A fresh alias (`t1`, `l2`, …). */
  alias(prefix: string): string {
    return `${prefix}${++this.#next}`;
  }
}

// ── The plan: the select tree with each embed resolved and the filters routed to it ─────────

/** One level of the select tree. */
export interface PlanNode {
  /** What it reads. */
  readonly source: QuerySource;
  /** Its select list. */
  readonly items: readonly SelectItem[];
  /** Its embeds, by output key. */
  readonly children: Map<string, PlanChild>;
  /** Its `WHERE` conditions (ANDed). */
  readonly conditions: Condition[];
  /** Its `ORDER BY`. */
  order: OrderTerm[];
  /** Its `LIMIT`. */
  limit?: number;
  /** Its `OFFSET`. */
  offset?: number;
}

/** An embedded level. */
interface PlanChild extends PlanNode {
  /** The select item. */
  readonly embed: SelectEmbed;
  /** The relationship to the parent. */
  readonly rel: Relationship;
  /** `books(count)`: the number of related rows instead of the rows. */
  readonly count: boolean;
  /** `rel=is.null` (`true`) or `rel=not.is.null` (`false`). */
  isNull?: boolean;
}

/** Whether an embed's select is PostgREST's `count` shorthand for the target. */
function isCountShorthand(embed: SelectEmbed, target: RestTable): boolean {
  const [only] = embed.select;
  return embed.select.length === 1 && only.kind === "field" && only.field.column === "count" &&
    only.field.path.length === 0 && only.cast === undefined &&
    !target.columns.some((c) => c.name === "count");
}

/** Resolve one embed item under `parent`. */
function childOf(catalog: RestCatalog, parent: QuerySource, embed: SelectEmbed): PlanChild {
  if (!parent.relation) {
    throw new RestError(
      400,
      "PGRST200",
      `'${parent.name}' has no relationships to embed '${embed.name}' through`,
    );
  }
  const rel = resolveRelationship(catalog, parent.relation, embed.name, embed.hint);
  if (embed.spread && !rel.toOne) {
    throw new RestError(
      400,
      "PGRST119",
      `A spread operation on '${embed.name}' is not possible`,
      `'${parent.name}' and '${embed.name}' do not form a many-to-one or one-to-one relationship`,
    );
  }
  const count = isCountShorthand(embed, rel.target);
  const node = planOf(catalog, tableSource(rel.target), count ? [] : embed.select);
  return { ...node, embed, rel, count };
}

/**
 * The plan for a select list over `source`: each embed resolved through the catalog.
 *
 * @param catalog The catalog.
 * @param source What the level reads.
 * @param items Its select list.
 * @returns The plan.
 * @throws {RestError} For an embed no relationship (or several) matches.
 */
export function planOf(
  catalog: RestCatalog,
  source: QuerySource,
  items: readonly SelectItem[],
): PlanNode {
  const children = new Map<string, PlanChild>();
  for (const item of items) {
    if (item.kind === "embed") children.set(item.key, childOf(catalog, source, item));
  }
  return { source, items, children, conditions: [], order: [] };
}

/** Query parameters that are never filters. */
const NOT_FILTERS = new Set(["select", "columns", "on_conflict"]);

/** The level a `books.authors.title` key names, and the rest of the key. */
function route(root: PlanNode, key: string): { node: PlanNode; rest: string } {
  let node = root;
  let rest = key;
  for (let dot = rest.indexOf("."); dot > 0; dot = rest.indexOf(".")) {
    const child = node.children.get(rest.slice(0, dot));
    if (!child) break;
    node = child;
    rest = rest.slice(dot + 1);
  }
  return { node, rest };
}

/** `rel=is.null` / `rel=not.is.null` on an embed. */
function embedNullFilter(child: PlanChild, key: string, value: string): void {
  const filter = parseFilterValue(value, key);
  if (filter.op !== "is" || filter.value !== "null" || child.embed.spread) {
    throw parseError(
      `${shown(key)} names an embedded resource: only ${key}=is.null or not.is.null filter it`,
    );
  }
  child.isNull = !filter.negate;
}

/** A non-negative integer query parameter, or `undefined` when absent. */
export function countParam(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw parseError(`${name} must be a non-negative integer`);
  return Number(raw);
}

/** Route one query parameter into the plan. */
function applyParam(
  root: PlanNode,
  key: string,
  value: string,
  counter: { filters: number },
): void {
  const { node, rest } = route(root, key);
  const child = node.children.get(rest);
  if (rest === "order") node.order = parseOrder(value);
  else if (rest === "limit" || rest === "offset") {
    if (node !== root) node[rest] = countParam(value, key);
  } else if (rest === "or" || rest === "and" || rest === "not.or" || rest === "not.and") {
    const negate = rest.startsWith("not.");
    const op = (negate ? rest.slice(4) : rest) as "and" | "or";
    node.conditions.push(parseLogic(op, negate, value, counter));
  } else if (child) embedNullFilter(child, key, value);
  else {
    counter.filters++;
    node.conditions.push({
      kind: "filter",
      field: parseField(rest),
      filter: parseFilterValue(value, rest),
    });
  }
}

/**
 * Route the request's query into the plan: filters, logic trees, `order`, and the embedded
 * levels' `limit` / `offset` (the top level's paging is the caller's: it is capped by `maxRows`).
 *
 * @param plan The plan.
 * @param query The query.
 * @param skip Parameters that are not filters here (an RPC's arguments).
 * @returns How many filters the request has (logic-tree leaves included).
 * @throws {RestError} For a malformed parameter or too many filters.
 */
export function applyQuery(
  plan: PlanNode,
  query: URLSearchParams,
  skip: ReadonlySet<string> = new Set(),
): number {
  const counter = { filters: 0 };
  for (const [key, value] of query) {
    if (NOT_FILTERS.has(key) || skip.has(key)) continue;
    applyParam(plan, key, value, counter);
    if (counter.filters > MAX_FILTERS) {
      throw parseError(`a request takes at most ${MAX_FILTERS} filters`);
    }
  }
  return counter.filters;
}

// ── Expressions ──────────────────────────────────────────────────────────────

/** A field as SQL, and the type a value compared to it is cast to. */
function fieldExpr(sql: Sql, source: QuerySource, alias: string, field: FieldRef) {
  const column = columnOf(source, field.column);
  let text = `${alias}.${quoteIdent(column.name)}`;
  for (const step of field.path) {
    const key = /^-?\d+$/.test(step.key)
      ? sql.params.bind("integer", step.key)
      : sql.params.bind("text", step.key);
    text = `${text}${step.arrow}${key}`;
  }
  const last = field.path.at(-1);
  if (!last) return { text, type: column.castType };
  return last.arrow === "->>"
    ? { text: `(${text})`, type: "text" }
    : { text: `(${text})::jsonb`, type: "jsonb" };
}

/** `cmp` operators to SQL. */
const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
  match: "~",
  imatch: "~*",
};

/** Operators whose right side is text whatever the column. */
const TEXT_OPERATORS = new Set(["like", "ilike", "match", "imatch"]);

/** Geometric / range / containment operators to SQL. */
const SET_OPERATORS: Record<string, string> = {
  cs: "@>",
  cd: "<@",
  ov: "&&",
  sl: "<<",
  sr: ">>",
  nxr: "&<",
  nxl: "&>",
  adj: "-|-",
};

/** Full-text operators to their `tsquery` builders. */
const TEXT_SEARCH: Record<string, string> = {
  fts: "to_tsquery",
  plfts: "plainto_tsquery",
  phfts: "phraseto_tsquery",
  wfts: "websearch_to_tsquery",
};

/** `is.<value>` → SQL. */
const IS_VALUES: Record<string, string> = {
  null: "NULL",
  true: "TRUE",
  false: "FALSE",
  unknown: "UNKNOWN",
};

/** A comparison or pattern, maybe `(any)` / `(all)` of an array. */
function comparison(sql: Sql, lhs: string, type: string, f: FilterValue): string {
  const valueType = TEXT_OPERATORS.has(f.op) ? "text" : type;
  const value = f.op === "like" || f.op === "ilike" ? f.value.replaceAll("*", "%") : f.value;
  if (f.modifier === undefined) {
    return `${lhs} ${COMPARISONS[f.op]} ${sql.params.bind(valueType, value)}`;
  }
  if (f.modifier !== "any" && f.modifier !== "all") {
    throw parseError(`${f.op} takes (any) or (all), not (${f.modifier})`);
  }
  const list = sql.params.bind(`${valueType}[]`, value);
  return `${lhs} ${COMPARISONS[f.op]} ${f.modifier.toUpperCase()}(${list})`;
}

/** A full-text match, with an optional text-search configuration. */
function textSearch(sql: Sql, lhs: string, type: string, f: FilterValue): string {
  const config = f.modifier === undefined ? "" : `${sql.params.bind("regconfig", f.modifier)}, `;
  const vector = type === "tsvector" ? lhs : `to_tsvector(${config}${lhs})`;
  return `${vector} @@ ${TEXT_SEARCH[f.op]}(${config}${sql.params.bind("text", f.value)})`;
}

/** A filter's condition on `lhs`. */
function operatorSql(sql: Sql, lhs: string, type: string, f: FilterValue): string {
  if (f.op in COMPARISONS) return comparison(sql, lhs, type, f);
  if (f.op in TEXT_SEARCH) return textSearch(sql, lhs, type, f);
  if (f.modifier !== undefined) throw parseError(`${f.op} takes no (${f.modifier})`);
  if (f.op in SET_OPERATORS) {
    return `${lhs} ${SET_OPERATORS[f.op]} ${sql.params.bind(type, f.value)}`;
  }
  if (f.op === "isdistinct") return `${lhs} IS DISTINCT FROM ${sql.params.bind(type, f.value)}`;
  if (f.op === "in") {
    const items = parseInList(f.value);
    if (items.length === 0) return "FALSE";
    return `${lhs} IN (${items.map((item) => sql.params.bind(type, item)).join(", ")})`;
  }
  const keyword = f.value.toLowerCase();
  if (!Object.hasOwn(IS_VALUES, keyword)) {
    throw parseError("is takes null, true, false or unknown");
  }
  return `${lhs} IS ${IS_VALUES[keyword]}`;
}

/** A condition (a filter or a group) as SQL. */
function conditionSql(sql: Sql, source: QuerySource, alias: string, c: Condition): string {
  if (c.kind === "group") {
    const joined = c.items.map((item) => conditionSql(sql, source, alias, item))
      .join(` ${c.op.toUpperCase()} `);
    return c.negate ? `NOT (${joined})` : `(${joined})`;
  }
  const { text, type } = fieldExpr(sql, source, alias, c.field);
  const condition = operatorSql(sql, text, type, c.filter);
  return c.filter.negate ? `NOT (${condition})` : condition;
}

/** A `::cast` from the request → its SQL, through the catalog's whitelist. */
function castSql(catalog: RestCatalog, cast: string): string {
  const array = cast.endsWith("[]");
  const base = array ? cast.slice(0, -2) : cast;
  const known = catalog.castTypes.get(base) ?? catalog.castTypes.get(base.toLowerCase());
  if (!known) throw new RestError(400, "42704", `type ${shown(cast)} does not exist`);
  return array ? `${known}[]` : known;
}

/** `ORDER BY` terms. */
function orderSql(sql: Sql, source: QuerySource, alias: string, order: OrderTerm[]): string {
  if (!order.length) return "";
  const terms = order.map((term) =>
    fieldExpr(sql, source, alias, term.field).text + (term.descending ? " DESC" : " ASC") +
    (term.nulls ? (term.nulls === "first" ? " NULLS FIRST" : " NULLS LAST") : "")
  );
  return ` ORDER BY ${terms.join(", ")}`;
}

// ── Rendering a level ────────────────────────────────────────────────────────

/** `full`: the rows; `count`: one `1` per matching row (no order or paging). */
type Mode = "full" | "count";

/** One rendered embed: its join, its select expression, its condition on the parent. */
interface Lateral {
  join: string;
  select: string;
  where: string | undefined;
}

/** The `FROM` and correlation for a child level under `parent`. */
function childFrom(sql: Sql, child: PlanChild, parent: string, alias: string) {
  const rel = child.rel;
  const target = `${qualified(rel.target)} AS ${alias}`;
  if (!rel.junction) {
    return {
      from: target,
      correlation: rel.pairs.map(([t, p]) =>
        `${alias}.${quoteIdent(t)} = ${parent}.${quoteIdent(p)}`
      ),
    };
  }
  const j = sql.alias("j");
  const on = rel.junction.toTarget.map(([jc, tc]) =>
    `${j}.${quoteIdent(jc)} = ${alias}.${quoteIdent(tc)}`
  ).join(" AND ");
  return {
    from: `${target} JOIN ${qualified(rel.junction.table)} AS ${j} ON ${on}`,
    correlation: rel.junction.toParent.map(([jc, pc]) =>
      `${j}.${quoteIdent(jc)} = ${parent}.${quoteIdent(pc)}`
    ),
  };
}

/** The value an embed's lateral yields as `v`. */
function lateralValue(child: PlanChild, inner: string): string {
  if (child.count) {
    const counted = "json_build_object('count', count(*))";
    return `SELECT ${child.rel.toOne ? counted : `json_build_array(${counted})`} AS v ` +
      `FROM (${inner}) _e`;
  }
  return child.rel.toOne
    ? `SELECT row_to_json(_e) AS v FROM (${inner}) _e`
    : `SELECT json_agg(_e) AS v FROM (${inner}) _e`;
}

/** Render one embed under the parent alias. */
function lateralOf(sql: Sql, child: PlanChild, parent: string, depth: number): Lateral {
  const alias = sql.alias("t");
  const l = sql.alias("l");
  const { from, correlation } = childFrom(sql, child, parent, alias);
  const inner = renderLevel(
    sql,
    child,
    from,
    alias,
    correlation,
    child.count ? "count" : "full",
    depth + 1,
  );
  const filtered = child.embed.inner || child.isNull === false;
  if (child.embed.spread) {
    const join = filtered ? "JOIN LATERAL" : "LEFT JOIN LATERAL";
    return { join: ` ${join} (${inner}) AS ${l} ON TRUE`, select: `${l}.*`, where: undefined };
  }
  const value = child.rel.toOne || child.count ? `${l}.v` : `coalesce(${l}.v, '[]'::json)`;
  const where = filtered ? `${l}.v IS NOT NULL` : child.isNull ? `${l}.v IS NULL` : undefined;
  return {
    join: ` LEFT JOIN LATERAL (${lateralValue(child, inner)}) AS ${l} ON TRUE`,
    select: `${value} AS ${quoteIdent(child.embed.key)}`,
    where,
  };
}

/** Whether a count needs this embed (it filters the parent's rows). */
function filtersParent(child: PlanChild): boolean {
  return child.embed.inner || child.isNull !== undefined;
}

/** A select item as SQL. */
function itemSql(
  sql: Sql,
  node: PlanNode,
  alias: string,
  item: SelectItem,
  laterals: Map<string, Lateral>,
): string | undefined {
  if (item.kind === "star") return `${alias}.*`;
  if (item.kind === "embed") return laterals.get(item.key)?.select;
  const { text } = fieldExpr(sql, node.source, alias, item.field);
  const value = item.cast === undefined ? text : `(${text})::${castSql(sql.catalog, item.cast)}`;
  return `${value} AS ${quoteIdent(item.key)}`;
}

/**
 * Render one level: `SELECT <items> FROM <from> <laterals> WHERE <correlation, filters> ORDER
 * BY … LIMIT … OFFSET …`.
 */
function renderLevel(
  sql: Sql,
  node: PlanNode,
  from: string,
  alias: string,
  correlation: string[],
  mode: Mode,
  depth = 0,
): string {
  if (depth > MAX_DEPTH) throw parseError(`embedding is limited to ${MAX_DEPTH} levels`);
  const laterals = new Map<string, Lateral>();
  for (const [key, child] of node.children) {
    if (mode === "count" && !filtersParent(child)) continue;
    laterals.set(key, lateralOf(sql, child, alias, depth));
  }
  const where = [
    ...correlation,
    ...node.conditions.map((c) => conditionSql(sql, node.source, alias, c)),
    ...[...laterals.values()].flatMap((l) => l.where ? [l.where] : []),
  ];
  const select = mode === "count"
    ? "1"
    : node.items.map((item) => itemSql(sql, node, alias, item, laterals))
      .filter((s): s is string => s !== undefined).join(", ");
  const joins = [...laterals.values()].map((l) => l.join).join("");
  let text = `SELECT ${select} FROM ${from}${joins}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  if (mode === "full") {
    text += orderSql(sql, node.source, alias, node.order);
    if (node.limit !== undefined) text += ` LIMIT ${node.limit}`;
    if (node.offset) text += ` OFFSET ${node.offset}`;
  }
  return text;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** How the rows are shaped into the response body. */
export type BodyShape = "json" | "stripped" | "geojson";

/** The aggregate that turns `_r`'s rows into the body text. */
function aggregate(shape: BodyShape): string {
  if (shape === "geojson") {
    return `json_build_object('type', 'FeatureCollection', 'features', ` +
      `coalesce(json_agg(ST_AsGeoJSON(_r)::json), '[]'))::text`;
  }
  const rows = `coalesce(json_agg(_r), '[]')`;
  return `${shape === "stripped" ? `json_strip_nulls(${rows})` : rows}::text`;
}

/** Options for {@linkcode buildSelect}. */
export interface SelectOptions {
  /** Rows to skip. */
  readonly offset: number;
  /** Rows to return (already capped at `maxRows`). */
  readonly limit: number;
  /** Also count every matching row (`Prefer: count=exact`). */
  readonly count: boolean;
  /** The body's shape (default `json`). */
  readonly shape?: BodyShape;
}

/** A source's `FROM` for the top level. */
function rootFrom(source: QuerySource): string {
  return `${qualified(source)} AS t0`;
}

/**
 * A read: `{ body, n[, total] }` — the page as one JSON text, its row count, and (with `count`)
 * every matching row's count.
 *
 * @param plan The plan, with the query applied.
 * @param catalog The catalog.
 * @param options Paging, counting, shape.
 * @returns The statement.
 * @throws {RestError} For an unknown column, operator, cast or modifier.
 */
export function buildSelect(
  plan: PlanNode,
  catalog: RestCatalog,
  options: SelectOptions,
): RestStatement {
  const sql = new Sql(catalog);
  plan.limit = options.limit;
  plan.offset = options.offset;
  const from = rootFrom(plan.source);
  const page = renderLevel(sql, plan, from, "t0", [], "full");
  const total = options.count
    ? `, (SELECT count(*) FROM (${renderLevel(sql, plan, from, "t0", [], "count")}) _c)::text ` +
      `AS total`
    : "";
  return {
    text: `SELECT ${aggregate(options.shape ?? "json")} AS body, count(*)::text AS n${total} ` +
      `FROM (${page}) _r`,
    params: sql.params.values,
  };
}

/**
 * The planner's estimate of the matching rows: `EXPLAIN (FORMAT JSON)` of the count query
 * (`Prefer: count=planned|estimated`).
 *
 * @param plan The plan, with the query applied.
 * @param catalog The catalog.
 * @param from The top level's `FROM` (default: the plan's relation as `t0`).
 * @returns The statement; its one row's `QUERY PLAN` holds the estimate.
 */
export function buildPlannedCount(
  plan: PlanNode,
  catalog: RestCatalog,
  from = rootFrom(plan.source),
): RestStatement {
  const sql = new Sql(catalog);
  return {
    text: `EXPLAIN (FORMAT JSON) ${renderLevel(sql, plan, from, "t0", [], "count")}`,
    params: sql.params.values,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

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
      throw new RestError(400, "428C9", `cannot write column ${shown(name)}: it is generated`);
    }
    return column;
  });
}

/** The parent-side columns an embed correlates on. */
function correlationColumns(child: PlanChild): string[] {
  return child.rel.junction
    ? child.rel.junction.toParent.map(([, p]) => p)
    : child.rel.pairs.map(([, p]) => p);
}

/** The `RETURNING` list a representation needs: every column it reads, or `*`. */
function returningList(plan: PlanNode): string {
  if (plan.items.some((item) => item.kind === "star")) return "t0.*";
  const names = new Set<string>();
  for (const item of plan.items) if (item.kind === "field") names.add(item.field.column);
  for (const child of plan.children.values()) {
    for (const c of correlationColumns(child)) names.add(c);
  }
  for (const term of plan.order) names.add(term.field.column);
  if (!names.size) return '1 AS "?"';
  return [...names].map((n) => `t0.${quoteIdent(columnOf(plan.source, n).name)}`).join(", ");
}

/** What a write answers with. */
export interface WriteReturn {
  /**
   * `representation`: the rows, shaped by the plan; `count`: only how many (`RETURNING 1`, which
   * reads no column, so no SELECT policy applies); `none`: nothing.
   */
  readonly kind: "representation" | "count" | "none";
  /** The body's shape. */
  readonly shape?: BodyShape;
}

/**
 * Wrap a data-modifying statement: `RETURNING` what the plan reads, shaped like a read (as
 * `{ body, n }`); or `RETURNING 1` counted (as `{ n }`); or the bare statement.
 */
function returning(sql: Sql, dml: string, plan: PlanNode, ret: WriteReturn): string {
  if (ret.kind === "none") return dml;
  if (ret.kind === "count") {
    return `WITH _m AS (${dml} RETURNING 1) SELECT count(*)::text AS n FROM _m`;
  }
  // The filters chose the rows the statement wrote; the written rows are not filtered again (an
  // update may have changed the very column a filter tested).
  const rows = renderLevel(sql, { ...plan, conditions: [] }, "_m AS t0", "t0", [], "full");
  return `WITH _m AS (${dml} RETURNING ${returningList(plan)}) ` +
    `SELECT ${aggregate(ret.shape ?? "json")} AS body, count(*)::text AS n FROM (${rows}) _r`;
}

/** `ON CONFLICT`: what an upsert does with a row that collides. */
export interface Conflict {
  /** `merge-duplicates` updates the row; `ignore-duplicates` keeps it. */
  readonly action: "merge" | "ignore";
  /** The conflict target (`on_conflict=`), else the primary key. */
  readonly columns?: readonly string[];
}

/** Options for {@linkcode buildInsert}. */
export interface InsertOptions {
  /** `columns=`: the body keys used (others ignored; missing ones are NULL or the default). */
  readonly columns?: readonly string[];
  /** `Prefer: missing=default`: a key a row leaves out takes the column's default. */
  readonly missingDefault?: boolean;
  /** An upsert's conflict handling. */
  readonly conflict?: Conflict;
  /** What to answer with. */
  readonly returning: WriteReturn;
}

/** The insert's columns: `columns=`, else the first row's keys (every row must match them). */
function insertColumns(rows: Record<string, unknown>[], columns?: readonly string[]): string[] {
  if (columns) return [...columns];
  const names = Object.keys(rows[0]);
  const key = [...names].sort().join("\0");
  if (rows.some((row) => Object.keys(row).sort().join("\0") !== key)) {
    throw new RestError(
      400,
      "PGRST102",
      "All object keys must match",
      null,
      "send the same keys in every object, or list the columns with columns=",
    );
  }
  return names;
}

/** The `ON CONFLICT` clause. */
function conflictSql(table: RestTable, columns: RestColumn[], conflict: Conflict): string {
  const target = conflict.columns ?? table.primaryKey;
  if (target.length === 0) {
    if (conflict.action === "ignore") return " ON CONFLICT DO NOTHING";
    throw new RestError(
      400,
      "PGRST100",
      `an upsert on ${shown(table.name)} needs on_conflict=: it has no primary key`,
    );
  }
  const list = target.map((name) => quoteIdent(columnOf(table, name).name)).join(", ");
  const updates = columns.filter((c) => !target.includes(c.name));
  if (conflict.action === "ignore" || updates.length === 0) {
    return ` ON CONFLICT (${list}) DO NOTHING`;
  }
  const set = updates.map((c) => `${quoteIdent(c.name)} = EXCLUDED.${quoteIdent(c.name)}`);
  return ` ON CONFLICT (${list}) DO UPDATE SET ${set.join(", ")}`;
}

/** `VALUES` rows where a missing key is `DEFAULT` (one `$n::json` parameter per row). */
function defaultingValues(
  sql: Sql,
  table: RestTable,
  rows: Record<string, unknown>[],
  columns: RestColumn[],
): string {
  if (rows.length > MAX_DEFAULT_ROWS) {
    throw new RestError(
      400,
      "PGRST102",
      `missing=default inserts at most ${MAX_DEFAULT_ROWS} rows at once`,
    );
  }
  const target = qualified(table);
  return "VALUES " + rows.map((row) => {
    const json = sql.params.bind("json", JSON.stringify(row));
    const cells = columns.map((c) =>
      Object.hasOwn(row, c.name)
        ? `(SELECT _p.${quoteIdent(c.name)} FROM json_populate_record(NULL::${target}, ${json}) _p)`
        : "DEFAULT"
    );
    return `(${cells.join(", ")})`;
  }).join(", ");
}

/**
 * An insert (or an upsert) of one object or an array of objects, expanded from one `$n::json`
 * parameter by `json_populate_recordset` over the table's row type (or, with `missing=default`,
 * row by row so a missing key takes its default).
 *
 * @param table The catalog entry.
 * @param plan The representation's plan (`select=`, with the query applied).
 * @param catalog The catalog.
 * @param body The parsed body.
 * @param options Columns, defaults, conflict handling, what to answer with.
 * @returns The statement.
 * @throws {RestError} For a body that is not an object (or array of them), mismatched keys, or
 *   an unknown or generated column.
 */
export function buildInsert(
  table: RestTable,
  plan: PlanNode,
  catalog: RestCatalog,
  body: unknown,
  options: InsertOptions,
): RestStatement {
  const rows = Array.isArray(body) ? body.map(objectOf) : [objectOf(body)];
  if (rows.length === 0) {
    throw new RestError(400, "PGRST102", "the body is an empty array: nothing to insert");
  }
  const columns = writableColumns(table, insertColumns(rows, options.columns));
  const sql = new Sql(catalog);
  const target = `${qualified(table)} AS t0`;
  let dml: string;
  if (columns.length === 0) {
    if (rows.length > 1) {
      throw new RestError(
        400,
        "PGRST102",
        "objects without keys can only be inserted one at a time",
      );
    }
    dml = `INSERT INTO ${target} DEFAULT VALUES`;
  } else {
    const list = columns.map((c) => quoteIdent(c.name)).join(", ");
    const source = options.missingDefault
      ? defaultingValues(sql, table, rows, columns)
      : `SELECT ${list} FROM json_populate_recordset(NULL::${qualified(table)}, ` +
        `${sql.params.bind("json", JSON.stringify(rows))})`;
    dml = `INSERT INTO ${target} (${list}) ${source}`;
  }
  if (options.conflict) dml += conflictSql(table, columns, options.conflict);
  return { text: returning(sql, dml, plan, options.returning), params: sql.params.values };
}

/** The `WHERE` of a PATCH / DELETE: the top level's conditions; at least one is required. */
function mutationWhere(sql: Sql, plan: PlanNode, verb: "UPDATE" | "DELETE"): string {
  if (plan.conditions.length === 0) {
    throw new RestError(
      400,
      "21000",
      `${verb} requires a WHERE clause`,
      null,
      "add a filter (?id=eq.1); to change every row, filter on a column every row matches",
    );
  }
  return " WHERE " + plan.conditions.map((c) => conditionSql(sql, plan.source, "t0", c))
    .join(" AND ");
}

/**
 * An update of the rows matching the filters, setting the body's columns (or `columns=`) from
 * one `$n::json` parameter. A request without a filter is refused.
 *
 * @param table The catalog entry.
 * @param plan The plan: the filters (required) and the representation's `select=`.
 * @param catalog The catalog.
 * @param body The parsed body: one object.
 * @param options `columns=` and what to answer with.
 * @returns The statement.
 * @throws {RestError} With no filter, an empty or non-object body, or an unknown column.
 */
export function buildUpdate(
  table: RestTable,
  plan: PlanNode,
  catalog: RestCatalog,
  body: unknown,
  options: { columns?: readonly string[]; returning: WriteReturn },
): RestStatement {
  if (Array.isArray(body)) {
    throw new RestError(400, "PGRST102", "an update takes one JSON object, not an array");
  }
  const values = objectOf(body);
  const columns = writableColumns(table, options.columns ?? Object.keys(values));
  if (columns.length === 0) throw new RestError(400, "PGRST102", "nothing to update");
  const sql = new Sql(catalog);
  const target = qualified(table);
  const json = sql.params.bind("json", JSON.stringify(values));
  const list = columns.map((c) => quoteIdent(c.name)).join(", ");
  const update = `UPDATE ${target} AS t0 SET (${list}) = ` +
    `(SELECT ${list} FROM json_populate_record(NULL::${target}, ${json}))` +
    mutationWhere(sql, plan, "UPDATE");
  return { text: returning(sql, update, plan, options.returning), params: sql.params.values };
}

/**
 * A delete of the rows matching the filters. A request without a filter is refused.
 *
 * @param table The catalog entry.
 * @param plan The plan: the filters (required) and the representation's `select=`.
 * @param catalog The catalog.
 * @param options What to answer with.
 * @returns The statement.
 * @throws {RestError} With no filter, or an unknown column or operator.
 */
export function buildDelete(
  table: RestTable,
  plan: PlanNode,
  catalog: RestCatalog,
  options: { returning: WriteReturn },
): RestStatement {
  const sql = new Sql(catalog);
  const dml = `DELETE FROM ${qualified(table)} AS t0${mutationWhere(sql, plan, "DELETE")}`;
  return { text: returning(sql, dml, plan, options.returning), params: sql.params.values };
}

// ── Functions (`/rpc/<fn>`) ──────────────────────────────────────────────────

/** How a call's arguments arrive. */
export type RpcInput =
  | { readonly kind: "body"; readonly body: unknown }
  | { readonly kind: "query"; readonly query: URLSearchParams };

/** Whether a type is `json` / `jsonb`. */
function isJson(arg: RestFunctionArg): boolean {
  return arg.typeName === "json" || arg.typeName === "jsonb";
}

/** The overload taking the whole body as its one unnamed (or `single`) json argument. */
function singleJsonOverload(
  overloads: readonly RestFunction[],
  single: boolean,
): RestFunction | undefined {
  return overloads.find((fn) =>
    fn.args.length === 1 && isJson(fn.args[0]) && (single || fn.args[0].name === "")
  );
}

/** Whether an overload takes exactly `keys` (every required one, no unknown one). */
function takes(fn: RestFunction, keys: readonly string[]): boolean {
  const names = new Set(fn.args.map((a) => a.name));
  return keys.every((k) => names.has(k)) &&
    fn.args.every((a) => a.hasDefault || keys.includes(a.name));
}

/** The argument names a call supplies. */
function suppliedKeys(fn: RestFunction | undefined, input: RpcInput): string[] {
  if (input.kind === "body") {
    const body = input.body;
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body)
      : [];
  }
  const keys = [...new Set(input.query.keys())];
  return fn ? keys.filter((k) => fn.args.some((a) => a.name === k)) : keys;
}

/** Pick the overload a call means. */
function overloadOf(
  overloads: readonly RestFunction[],
  input: RpcInput,
  single: boolean,
): { fn: RestFunction; whole: boolean } | undefined {
  if (input.kind === "body") {
    const whole = singleJsonOverload(overloads, single);
    if (single && whole) return { fn: whole, whole: true };
    const matches = overloads.filter((fn) => takes(fn, suppliedKeys(undefined, input)));
    if (matches.length > 1) ambiguous(overloads[0]);
    if (matches.length === 1) return { fn: matches[0], whole: false };
    return whole ? { fn: whole, whole: true } : undefined;
  }
  // GET: parameters naming no argument are filters on the result.
  const matches = overloads.filter((fn) => takes(fn, suppliedKeys(fn, input)));
  if (matches.length > 1) {
    const most = Math.max(...matches.map((fn) => suppliedKeys(fn, input).length));
    const best = matches.filter((fn) => suppliedKeys(fn, input).length === most);
    if (best.length > 1) ambiguous(overloads[0]);
    return { fn: best[0], whole: false };
  }
  return matches.length ? { fn: matches[0], whole: false } : undefined;
}

/** PostgREST's 300 for overloads it cannot tell apart. */
function ambiguous(fn: RestFunction): never {
  throw new RestError(
    300,
    "PGRST203",
    `Could not choose the best candidate function between the overloads of ${fn.schema}.${fn.name}`,
    null,
    "Try renaming the parameters or the function itself in the database so function overloading can be resolved",
  );
}

/**
 * The function a call names: the overload whose arguments match the supplied names (a body's
 * keys, or the query parameters naming an argument), or the one taking the whole body as a
 * single json argument.
 *
 * @param catalog The catalog.
 * @param schema The schema.
 * @param name The function.
 * @param input The arguments.
 * @param single `Prefer: params=single-object`.
 * @returns The function, and whether it takes the whole body.
 * @throws {RestError} `PGRST202` (404) when none matches, `PGRST203` (300) when several do.
 */
export function resolveFunction(
  catalog: RestCatalog,
  schema: string,
  name: string,
  input: RpcInput,
  single: boolean,
): { fn: RestFunction; whole: boolean } {
  const overloads = catalog.functions.get(schema)?.get(name) ?? [];
  const found = overloads.length ? overloadOf(overloads, input, single) : undefined;
  if (found) return found;
  const keys = suppliedKeys(undefined, input).sort().join(", ");
  throw new RestError(
    404,
    "PGRST202",
    `Could not find the function ${schema}.${name}(${keys.slice(0, 200)}) in the schema cache`,
    `Searched for the function ${schema}.${name} with parameters ${
      keys.slice(0, 200) || "(none)"
    }` +
      ", but no matches were found in the schema cache.",
    "Check the function's name and its parameters' names, and that anon or authenticated may EXECUTE it",
  );
}

/** The call expression: `"schema"."fn"("a" => …, …)`. */
function callSql(sql: Sql, fn: RestFunction, input: RpcInput, whole: boolean): string {
  const name = qualified(fn);
  if (input.kind === "body" && whole) {
    return `${name}(${sql.params.bind(fn.args[0].castType, JSON.stringify(input.body))})`;
  }
  const args = input.kind === "body" ? bodyArgs(sql, fn, input) : queryArgs(sql, fn, input.query);
  return `${name}(${args.join(", ")})`;
}

/** `"name" => value`, `VARIADIC` first for a variadic argument. */
function namedArg(arg: RestFunctionArg, value: string): string {
  return `${arg.variadic ? "VARIADIC " : ""}${quoteIdent(arg.name)} => ${value}`;
}

/** Arguments from a JSON body: each read from one `$n::json` with `json_to_record`. */
function bodyArgs(sql: Sql, fn: RestFunction, input: RpcInput & { kind: "body" }): string[] {
  const keys = suppliedKeys(fn, input);
  if (!keys.length) return [];
  const json = sql.params.bind("json", JSON.stringify(input.body));
  return fn.args.filter((a) => keys.includes(a.name)).map((arg) =>
    namedArg(
      arg,
      `(SELECT _a.${quoteIdent(arg.name)} FROM json_to_record(${json}) ` +
        `AS _a(${quoteIdent(arg.name)} ${arg.castType}))`,
    )
  );
}

/** Arguments from the query string: each a `$n` cast to the argument's type. */
function queryArgs(sql: Sql, fn: RestFunction, query: URLSearchParams): string[] {
  return fn.args.filter((arg) => query.has(arg.name)).map((arg) =>
    namedArg(arg, sql.params.bind(arg.castType, query.get(arg.name)!))
  );
}

/**
 * A function's result rows as a query source (filters, `select=` and embeds apply to them).
 *
 * @param fn The function.
 * @returns The source.
 */
export function functionSource(fn: RestFunction): QuerySource {
  const columns = fn.returns.columns ?? [];
  return {
    schema: fn.schema,
    name: fn.name,
    columns,
    ...(fn.returns.table ? { relation: fn.returns.table } : {}),
  };
}

/** Options for {@linkcode buildRpc}. */
export interface RpcOptions extends SelectOptions {
  /** The function. */
  readonly fn: RestFunction;
  /** It takes the whole body as its one json argument. */
  readonly whole: boolean;
  /** Its arguments. */
  readonly input: RpcInput;
}

/**
 * A function call. Its result is read once (`WITH _f AS MATERIALIZED`, so a volatile function
 * runs once however the rows are counted): a set or a composite as rows (`select=`, filters,
 * order and paging apply, as to a table), a scalar as its JSON value, `void` as nothing.
 *
 * @param plan The plan over {@linkcode functionSource}, with the query applied.
 * @param catalog The catalog.
 * @param options The call, paging and counting.
 * @returns The statement: `{ body, n[, total] }` (`void`: `{ n }`).
 */
export function buildRpc(
  plan: PlanNode,
  catalog: RestCatalog,
  options: RpcOptions,
): RestStatement {
  const sql = new Sql(catalog);
  const call = callSql(sql, options.fn, options.input, options.whole);
  const result = options.fn.returns;
  let text: string;
  if (result.kind === "void") {
    text = `SELECT count(*)::text AS n FROM (SELECT ${call}) _v`;
  } else if (result.kind === "scalar" && !options.fn.setOf) {
    text = `SELECT to_json(${call})::text AS body, '1' AS n`;
  } else if (result.kind === "scalar") {
    const page = ` LIMIT ${options.limit}` + (options.offset ? ` OFFSET ${options.offset}` : "");
    const total = options.count ? `, (SELECT count(*) FROM _f)::text AS total` : "";
    text = `WITH _f AS MATERIALIZED (SELECT _x AS v FROM ${call} AS _x) ` +
      `SELECT coalesce(json_agg(_r.v), '[]')::text AS body, count(*)::text AS n${total} ` +
      `FROM (SELECT v FROM _f${page}) _r`;
  } else {
    plan.limit = options.limit;
    plan.offset = options.offset;
    const page = renderLevel(sql, plan, "_f AS t0", "t0", [], "full");
    const total = options.count
      ? `, (SELECT count(*) FROM (${renderLevel(sql, plan, "_f AS t0", "t0", [], "count")}) _c)` +
        `::text AS total`
      : "";
    text = `WITH _f AS MATERIALIZED (SELECT * FROM ${call} AS _x) ` +
      `SELECT ${aggregate(options.shape ?? "json")} AS body, count(*)::text AS n${total} ` +
      `FROM (${page}) _r`;
  }
  return { text, params: sql.params.values };
}

/**
 * The planner's estimate of a function's result rows (`count=planned|estimated`).
 *
 * @param plan The plan over the function's result.
 * @param catalog The catalog.
 * @param options The call.
 * @returns The statement.
 */
export function buildRpcPlannedCount(
  plan: PlanNode,
  catalog: RestCatalog,
  options: Pick<RpcOptions, "fn" | "whole" | "input">,
): RestStatement {
  const sql = new Sql(catalog);
  const call = callSql(sql, options.fn, options.input, options.whole);
  const from = options.fn.returns.kind === "composite"
    ? `(SELECT * FROM ${call} AS _x) AS t0`
    : `(SELECT _x AS v FROM ${call} AS _x) AS t0`;
  const level = options.fn.returns.kind === "composite"
    ? renderLevel(sql, plan, from, "t0", [], "count")
    : `SELECT 1 FROM ${from}`;
  return { text: `EXPLAIN (FORMAT JSON) ${level}`, params: sql.params.values };
}
