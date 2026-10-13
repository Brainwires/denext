// The browser half of auto-REST: `from("table")`, `rpc("fn")` and `schema("api")` build requests
// to `backend({ rest })`'s routes with the same API as `@supabase/supabase-js`'s PostgREST client
// — every filter (`eq` … `textSearch`, `or`, `not`, `match`, `filter`), the transforms (`select`,
// `order`, `limit`, `range`, `single`, `maybeSingle`, `csv`, `geojson`, `explain`, `rollback`,
// `abortSignal`, `throwOnError`), `insert` / `upsert` / `update` / `delete` — resolving to
// `{ data, error, count, status, statusText }`. Row types come from `.denext/rest.ts` (generated
// from the live catalog), registered on `RegisteredRest`. No server imports: safe to bundle for
// the browser.

/**
 * Augmentation target for the generated `.denext/rest.ts`:
 * `declare module "@denext/backend/client" { interface RegisteredRest { tables: … } }` types
 * `from("table")` with each table's row, insert and update shapes.
 */
// deno-lint-ignore no-empty-interface
export interface RegisteredRest {}

/** One table's shapes. */
export interface RestTableShape {
  /** A row, as reads return it. */
  Row: Record<string, unknown>;
  /** What an insert takes. */
  Insert: Record<string, unknown>;
  /** What an update takes. */
  Update: Record<string, unknown>;
}

/** Every table's shapes: the generated ones, or any name with untyped rows. */
export type RestTables = RegisteredRest extends { tables: infer T } ? T
  : Record<string, RestTableShape>;

/** A table name the client accepts. */
export type RestTableName = keyof RestTables & string;

/** The shapes of table `K`: its generated `Row` / `Insert` / `Update`, or untyped ones. */
export type RestTableShapeOf<K extends RestTableName> = RestTables[K] extends
  { Row: infer R; Insert: infer I; Update: infer U } ? { Row: R; Insert: I; Update: U }
  : RestTables[K] extends { Row: infer R } ? { Row: R; Insert: never; Update: never }
  : RestTableShape;

/** The column names a `select("a, b")` string lists (`"a" | "b"`), spaces trimmed. */
export type SelectColumns<S extends string> = S extends `${infer A},${infer B}`
  ? SelectColumns<A> | SelectColumns<B>
  : S extends ` ${infer R}` ? SelectColumns<R>
  : S extends `${infer R} ` ? SelectColumns<R>
  : S;

/**
 * The row shape `select(columns)` returns: the listed columns of `Row`, all of it for `*`, and
 * a plain record when the list embeds, aliases, casts or follows JSON paths.
 */
export type Selected<Row, S extends string> = S extends
  `${string}(${string}` | `${string}:${string}` | `${string}->${string}` ? Record<string, unknown>
  : "*" extends SelectColumns<S> ? Row
  : Pick<Row, SelectColumns<S> & keyof Row>;

/** A refused or failed REST request: the server's PostgREST-shaped error. */
export class RestClientError extends Error {
  /** A PostgREST-style code (`PGRST100`) or a Postgres SQLSTATE (`23505`). */
  readonly code: string;
  /** The HTTP status (0 when the request never reached the server). */
  readonly status: number;
  /** More detail, if any. */
  readonly details: string | null;
  /** How to fix it, if known. */
  readonly hint: string | null;

  /**
   * Build the error.
   *
   * @param code The code.
   * @param status The HTTP status.
   * @param message What went wrong.
   * @param details More detail.
   * @param hint How to fix it.
   */
  constructor(
    code: string,
    status: number,
    message: string,
    details: string | null = null,
    hint: string | null = null,
  ) {
    super(message);
    this.name = "RestClientError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}

/** What a request resolves to: never a rejection (unless `throwOnError()`), so check `error`. */
export interface RestResult<T> {
  /** The rows (or row, after `single()`); `null` on error or for a write without `select()`. */
  data: T | null;
  /** The error, or `null`. */
  error: RestClientError | null;
  /** Every matching row's count, when `count` was asked for. */
  count: number | null;
  /** The HTTP status. */
  status: number;
  /** The HTTP status text. */
  statusText: string;
}

/** Options for {@linkcode restClient}. */
export interface RestClientOptions {
  /** The routes' base URL (default: `<basePath>/rest/v1` on the page's origin). */
  url?: string;
  /** Extra headers on every request (`Authorization: Bearer …` for a native session). */
  headers?: HeadersInit;
  /** The `fetch` to use (default: the global one). */
  fetch?: typeof fetch;
  /** The schema (`Accept-Profile` / `Content-Profile`; default: the server's first). */
  schema?: string;
}

/** `count` options: exactly, or the planner's estimate. */
export type RestCount = "exact" | "planned" | "estimated";

/** The operators `not()` and `filter()` take. */
export type RestNegatable =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "match"
  | "imatch"
  | "is"
  | "isdistinct"
  | "in"
  | "cs"
  | "cd"
  | "ov"
  | "sl"
  | "sr"
  | "nxl"
  | "nxr"
  | "adj"
  | "fts"
  | "plfts"
  | "phfts"
  | "wfts"
  | `${string}(${string})`;

/** Which embedded level a transform applies to (`referencedTable`, or its old name). */
export interface RestReferenced {
  /** The embedded resource's name (or alias). */
  referencedTable?: string;
  /** The same, by its older name. */
  foreignTable?: string;
}

/** `explain()`'s options. */
export interface ExplainOptions {
  /** Run the statement (`EXPLAIN ANALYZE`; the transaction is rolled back). */
  analyze?: boolean;
  /** `VERBOSE`. */
  verbose?: boolean;
  /** `SETTINGS`. */
  settings?: boolean;
  /** `BUFFERS`. */
  buffers?: boolean;
  /** `WAL`. */
  wal?: boolean;
  /** `text` (the default) or `json`. */
  format?: "text" | "json";
}

/** A value a filter compares to, by the column's type. */
export type RestFilterValue<Row, C> = C extends keyof Row ? Row[C] : unknown;
/** A column name, or any text (JSON paths, embedded columns). */
export type RestColumnName<Row> = (keyof Row & string) | (string & Record<never, never>);

/**
 * A request being built: chain filters and transforms, then `await` it.
 *
 * @typeParam Row The table's row.
 * @typeParam Result What `data` holds.
 */
export interface RestQuery<Row, Result> extends PromiseLike<RestResult<Result>> {
  /** `column = value`. */
  eq<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column <> value`. */
  neq<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column > value`. */
  gt<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column >= value`. */
  gte<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column < value`. */
  lt<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column <= value`. */
  lte<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column LIKE pattern` (`%` or `*` match any run). */
  like(column: RestColumnName<Row>, pattern: string): RestQuery<Row, Result>;
  /** Every pattern matches. */
  likeAllOf(column: RestColumnName<Row>, patterns: readonly string[]): RestQuery<Row, Result>;
  /** Any pattern matches. */
  likeAnyOf(column: RestColumnName<Row>, patterns: readonly string[]): RestQuery<Row, Result>;
  /** `column ILIKE pattern` (case-insensitive). */
  ilike(column: RestColumnName<Row>, pattern: string): RestQuery<Row, Result>;
  /** Every pattern matches, case-insensitively. */
  ilikeAllOf(column: RestColumnName<Row>, patterns: readonly string[]): RestQuery<Row, Result>;
  /** Any pattern matches, case-insensitively. */
  ilikeAnyOf(column: RestColumnName<Row>, patterns: readonly string[]): RestQuery<Row, Result>;
  /** `column ~ pattern` (a POSIX regular expression). */
  regexMatch(column: RestColumnName<Row>, pattern: string): RestQuery<Row, Result>;
  /** `column ~* pattern` (case-insensitive). */
  regexIMatch(column: RestColumnName<Row>, pattern: string): RestQuery<Row, Result>;
  /** `column IS NULL | TRUE | FALSE`. */
  is(column: RestColumnName<Row>, value: null | boolean): RestQuery<Row, Result>;
  /** `column IS DISTINCT FROM value`. */
  isDistinct<C extends RestColumnName<Row>>(
    column: C,
    value: RestFilterValue<Row, C>,
  ): RestQuery<Row, Result>;
  /** `column IN (values…)`. */
  in<C extends RestColumnName<Row>>(
    column: C,
    values: readonly RestFilterValue<Row, C>[],
  ): RestQuery<Row, Result>;
  /** `column NOT IN (values…)`. */
  notIn<C extends RestColumnName<Row>>(
    column: C,
    values: readonly RestFilterValue<Row, C>[],
  ): RestQuery<Row, Result>;
  /** `column @> value` (an array, a range, or JSON). */
  contains(
    column: RestColumnName<Row>,
    value: string | readonly unknown[] | Record<string, unknown>,
  ): RestQuery<Row, Result>;
  /** `column <@ value`. */
  containedBy(
    column: RestColumnName<Row>,
    value: string | readonly unknown[] | Record<string, unknown>,
  ): RestQuery<Row, Result>;
  /** A range strictly right of `range`. */
  rangeGt(column: RestColumnName<Row>, range: string): RestQuery<Row, Result>;
  /** A range not extending left of `range`. */
  rangeGte(column: RestColumnName<Row>, range: string): RestQuery<Row, Result>;
  /** A range strictly left of `range`. */
  rangeLt(column: RestColumnName<Row>, range: string): RestQuery<Row, Result>;
  /** A range not extending right of `range`. */
  rangeLte(column: RestColumnName<Row>, range: string): RestQuery<Row, Result>;
  /** A range adjacent to `range`. */
  rangeAdjacent(column: RestColumnName<Row>, range: string): RestQuery<Row, Result>;
  /** `column && value` (an array or a range). */
  overlaps(column: RestColumnName<Row>, value: string | readonly unknown[]): RestQuery<Row, Result>;
  /** Full-text search. */
  textSearch(
    column: RestColumnName<Row>,
    query: string,
    options?: { config?: string; type?: "plain" | "phrase" | "websearch" },
  ): RestQuery<Row, Result>;
  /** `eq` on every key of `query`. */
  match(query: Partial<Row> | Record<string, unknown>): RestQuery<Row, Result>;
  /** Negate one operator: `not("status", "eq", "done")`. */
  not(column: RestColumnName<Row>, operator: RestNegatable, value: unknown): RestQuery<Row, Result>;
  /** Any of PostgREST's conditions: `or("a.eq.1,b.gt.2")`. */
  or(filters: string, options?: RestReferenced): RestQuery<Row, Result>;
  /** Any operator, PostgREST-spelled: `filter("tags", "cs", "{a}")`. */
  filter(
    column: RestColumnName<Row>,
    operator: RestNegatable,
    value: unknown,
  ): RestQuery<Row, Result>;
  /** Order by a column (call again for a tie-breaker). */
  order(
    column: RestColumnName<Row>,
    options?: { ascending?: boolean; nullsFirst?: boolean } & RestReferenced,
  ): RestQuery<Row, Result>;
  /** Return at most `count` rows (the server caps it at its `maxRows`). */
  limit(count: number, options?: RestReferenced): RestQuery<Row, Result>;
  /** Skip `count` rows. */
  offset(count: number, options?: RestReferenced): RestQuery<Row, Result>;
  /** Rows `from` … `to`, inclusive, zero-based. */
  range(from: number, to: number, options?: RestReferenced): RestQuery<Row, Result>;
  /**
   * After `insert` / `upsert` / `update` / `delete`: return the written rows (their `columns`).
   *
   * @param columns Comma-separated columns, embeds, aliases… or `*` (the default).
   * @returns The request, now resolving to the rows.
   */
  select<S extends string = "*">(columns?: S): RestQuery<Row, Selected<Row, S>[]>;
  /** Expect exactly one row: `data` is that row, and zero or several rows are an error. */
  single(): RestQuery<Row, Result extends readonly (infer E)[] ? E : Result>;
  /** Expect at most one row: `data` is that row or `null`; several rows are an error. */
  maybeSingle(): RestQuery<Row, (Result extends readonly (infer E)[] ? E : Result) | null>;
  /** Answer CSV text. */
  csv(): RestQuery<Row, string>;
  /** Answer a GeoJSON FeatureCollection (needs PostGIS). */
  geojson(): RestQuery<Row, Record<string, unknown>>;
  /** Answer the execution plan (the server must enable `explain`). */
  explain(options?: ExplainOptions): RestQuery<Row, unknown>;
  /** Run the statement, then roll it back. */
  rollback(): RestQuery<Row, Result>;
  /** Re-type `data`. */
  returns<T>(): RestQuery<Row, T>;
  /** Reject on an error instead of resolving with it. */
  throwOnError(): RestQuery<Row, Result>;
  /** Abort the request with `signal`. */
  abortSignal(signal: AbortSignal): RestQuery<Row, Result>;
  /** Set a request header. */
  setHeader(name: string, value: string): RestQuery<Row, Result>;
  /** A write touching more rows than `count` fails and is rolled back. */
  maxAffected(count: number): RestQuery<Row, Result>;
}

/** A filter value as the URL carries it. */
function valueText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** One `in.(…)` item, quoted when it holds a separator, a quote or a space. */
function listItem(value: unknown): string {
  const text = valueText(value);
  return text === "" || /[,()"\\\s]/.test(text) ? `"${text.replace(/[\\"]/g, "\\$&")}"` : text;
}

/** An array literal `{a,b}` for `(any)` / `cs` / `ov`. */
function arrayLiteral(values: readonly unknown[]): string {
  return `{${values.map(listItem).join(",")}}`;
}

/** A `cs` / `cd` value: text as is, an array as `{…}`, an object as JSON. */
function containment(value: string | readonly unknown[] | Record<string, unknown>): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return arrayLiteral(value);
  return JSON.stringify(value);
}

/** Drop whitespace outside double quotes, as postgrest-js does for `select`. */
function compactColumns(columns: string): string {
  let quoted = false;
  return [...columns].filter((ch) => {
    if (ch === '"') quoted = !quoted;
    return quoted || !/\s/.test(ch);
  }).join("");
}

/** What one request is made of. */
interface RequestState {
  method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly body?: unknown;
  readonly schema?: string;
  readonly fetch: typeof fetch;
  signal?: AbortSignal;
  maybeSingle: boolean;
  throwOnError: boolean;
}

/** Add a token to the `Prefer` header. */
function prefer(headers: Headers, token: string): void {
  const current = headers.get("prefer");
  const tokens = current ? current.split(",").map((t) => t.trim()) : [];
  if (!tokens.includes(token)) tokens.push(token);
  headers.set("prefer", tokens.join(","));
}

/** The query key of a transform on an embedded level. */
function keyFor(name: string, options?: RestReferenced): string {
  const table = options?.referencedTable ?? options?.foreignTable;
  return table ? `${table}.${name}` : name;
}

/** The status text for a status. */
function statusText(status: number, fallback: string): string {
  return fallback || (status === 204 ? "No Content" : status === 200 ? "OK" : "");
}

/** A non-2xx answer → the client error. */
function errorOf(status: number, text: string): RestClientError {
  try {
    const e = JSON.parse(text) as {
      code?: string;
      message?: string;
      details?: unknown;
      hint?: string;
    };
    const details = e.details === undefined || e.details === null
      ? null
      : typeof e.details === "string"
      ? e.details
      : JSON.stringify(e.details);
    return new RestClientError(
      e.code ?? "http_error",
      status,
      e.message ?? text,
      details,
      e.hint ?? null,
    );
  } catch {
    return new RestClientError("http_error", status, text || `HTTP ${status}`);
  }
}

/** Whether the request asked for a text body (CSV, a text plan). */
function wantsText(headers: Headers): boolean {
  const accept = headers.get("accept") ?? "";
  return accept === "text/csv" || accept.includes("application/vnd.pgrst.plan+text");
}

/** The count from `Content-Range`, when one was asked for. */
function countOf(res: Response, headers: Headers): number | null {
  if (!/count=(exact|planned|estimated)/.test(headers.get("prefer") ?? "")) return null;
  const total = (res.headers.get("content-range") ?? "").split("/")[1];
  return total && total !== "*" ? Number(total) : null;
}

/** A successful answer's data, `maybeSingle` applied. */
function successOf<Result>(
  state: RequestState,
  res: Response,
  text: string,
): RestResult<Result> {
  const count = countOf(res, state.headers);
  let data: unknown = text === "" ? null : wantsText(state.headers) ? text : JSON.parse(text);
  if (state.maybeSingle && Array.isArray(data)) {
    if (data.length > 1) {
      const error = new RestClientError(
        "PGRST116",
        406,
        "JSON object requested, multiple (or no) rows returned",
        `Results contain ${data.length} rows, application/vnd.pgrst.object+json requires 1 row`,
      );
      return { data: null, error, count, status: 406, statusText: "Not Acceptable" };
    }
    data = data.length === 1 ? data[0] : null;
  }
  return {
    data: data as Result,
    error: null,
    count,
    status: res.status,
    statusText: statusText(res.status, res.statusText),
  };
}

/** A failed answer → the result (`maybeSingle` turns "0 rows" into `data: null`). */
function failureOf<Result>(
  state: RequestState,
  res: Response,
  text: string,
): RestResult<Result> {
  const error = errorOf(res.status, text);
  return {
    data: null,
    error,
    count: countOf(res, state.headers),
    status: res.status,
    statusText: statusText(res.status, res.statusText),
  };
}

/** The request's headers: the builder's, the profile header, and the body's type. */
function requestHeaders(state: RequestState): Headers {
  const headers = new Headers(state.headers);
  if (state.schema) {
    const read = state.method === "GET" || state.method === "HEAD";
    headers.set(read ? "accept-profile" : "content-profile", state.schema);
  }
  if (state.body !== undefined) headers.set("content-type", "application/json");
  return headers;
}

/** The fetch init for a request. */
function requestInit(state: RequestState): RequestInit {
  return {
    method: state.method,
    credentials: "same-origin",
    headers: requestHeaders(state),
    ...(state.signal ? { signal: state.signal } : {}),
    ...(state.body !== undefined ? { body: JSON.stringify(state.body) } : {}),
  };
}

/** A failure to reach the server, as a result (or thrown with `throwOnError`). */
function networkFailure<Result>(state: RequestState, error: unknown): RestResult<Result> {
  const message = (error as Error)?.message ?? String(error);
  const failure = new RestClientError("network_error", 0, message);
  if (state.throwOnError) throw failure;
  return { data: null, error: failure, count: null, status: 0, statusText: "" };
}

/** Send a request, answering a network failure as a result too. */
async function send<Result>(state: RequestState): Promise<RestResult<Result>> {
  const query = state.query.toString();
  let res: Response;
  try {
    res = await state.fetch(query ? `${state.url}?${query}` : state.url, requestInit(state));
  } catch (error) {
    return networkFailure<Result>(state, error);
  }
  const text = state.method === "HEAD" ? "" : await res.text();
  const result = res.ok ? successOf<Result>(state, res, text) : failureOf<Result>(state, res, text);
  if (result.error && state.throwOnError) throw result.error;
  return result;
}

/** The request builder: every method records into the state and returns the builder. */
class Builder {
  readonly #state: RequestState;

  constructor(state: RequestState) {
    this.#state = state;
  }

  #filter(column: string, value: string): this {
    this.#state.query.append(column, value);
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.#filter(column, `eq.${valueText(value)}`);
  }
  neq(column: string, value: unknown): this {
    return this.#filter(column, `neq.${valueText(value)}`);
  }
  gt(column: string, value: unknown): this {
    return this.#filter(column, `gt.${valueText(value)}`);
  }
  gte(column: string, value: unknown): this {
    return this.#filter(column, `gte.${valueText(value)}`);
  }
  lt(column: string, value: unknown): this {
    return this.#filter(column, `lt.${valueText(value)}`);
  }
  lte(column: string, value: unknown): this {
    return this.#filter(column, `lte.${valueText(value)}`);
  }
  like(column: string, pattern: string): this {
    return this.#filter(column, `like.${pattern}`);
  }
  likeAllOf(column: string, patterns: readonly string[]): this {
    return this.#filter(column, `like(all).${arrayLiteral(patterns)}`);
  }
  likeAnyOf(column: string, patterns: readonly string[]): this {
    return this.#filter(column, `like(any).${arrayLiteral(patterns)}`);
  }
  ilike(column: string, pattern: string): this {
    return this.#filter(column, `ilike.${pattern}`);
  }
  ilikeAllOf(column: string, patterns: readonly string[]): this {
    return this.#filter(column, `ilike(all).${arrayLiteral(patterns)}`);
  }
  ilikeAnyOf(column: string, patterns: readonly string[]): this {
    return this.#filter(column, `ilike(any).${arrayLiteral(patterns)}`);
  }
  regexMatch(column: string, pattern: string): this {
    return this.#filter(column, `match.${pattern}`);
  }
  regexIMatch(column: string, pattern: string): this {
    return this.#filter(column, `imatch.${pattern}`);
  }
  is(column: string, value: null | boolean): this {
    return this.#filter(column, `is.${value}`);
  }
  isDistinct(column: string, value: unknown): this {
    return this.#filter(column, `isdistinct.${valueText(value)}`);
  }
  in(column: string, values: readonly unknown[]): this {
    return this.#filter(column, `in.(${values.map(listItem).join(",")})`);
  }
  notIn(column: string, values: readonly unknown[]): this {
    return this.#filter(column, `not.in.(${values.map(listItem).join(",")})`);
  }
  contains(column: string, value: string | readonly unknown[] | Record<string, unknown>): this {
    return this.#filter(column, `cs.${containment(value)}`);
  }
  containedBy(column: string, value: string | readonly unknown[] | Record<string, unknown>): this {
    return this.#filter(column, `cd.${containment(value)}`);
  }
  rangeGt(column: string, range: string): this {
    return this.#filter(column, `sr.${range}`);
  }
  rangeGte(column: string, range: string): this {
    return this.#filter(column, `nxl.${range}`);
  }
  rangeLt(column: string, range: string): this {
    return this.#filter(column, `sl.${range}`);
  }
  rangeLte(column: string, range: string): this {
    return this.#filter(column, `nxr.${range}`);
  }
  rangeAdjacent(column: string, range: string): this {
    return this.#filter(column, `adj.${range}`);
  }
  overlaps(column: string, value: string | readonly unknown[]): this {
    return this.#filter(column, `ov.${typeof value === "string" ? value : arrayLiteral(value)}`);
  }
  textSearch(
    column: string,
    query: string,
    options: { config?: string; type?: "plain" | "phrase" | "websearch" } = {},
  ): this {
    const types: Record<string, string> = { plain: "pl", phrase: "ph", websearch: "w" };
    const type = options.type ? types[options.type] ?? "" : "";
    const config = options.config === undefined ? "" : `(${options.config})`;
    return this.#filter(column, `${type}fts${config}.${query}`);
  }
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) this.eq(column, value);
    return this;
  }
  not(column: string, operator: string, value: unknown): this {
    return this.#filter(column, `not.${operator}.${valueText(value)}`);
  }
  or(filters: string, options?: RestReferenced): this {
    return this.#filter(keyFor("or", options), `(${filters})`);
  }
  filter(column: string, operator: string, value: unknown): this {
    return this.#filter(column, `${operator}.${valueText(value)}`);
  }
  order(
    column: string,
    options: { ascending?: boolean; nullsFirst?: boolean } & RestReferenced = {},
  ): this {
    const key = keyFor("order", options);
    const nulls = options.nullsFirst === undefined
      ? ""
      : options.nullsFirst
      ? ".nullsfirst"
      : ".nullslast";
    const term = `${column}.${options.ascending === false ? "desc" : "asc"}${nulls}`;
    const previous = this.#state.query.get(key);
    this.#state.query.set(key, previous ? `${previous},${term}` : term);
    return this;
  }
  limit(count: number, options?: RestReferenced): this {
    this.#state.query.set(keyFor("limit", options), String(count));
    return this;
  }
  offset(count: number, options?: RestReferenced): this {
    this.#state.query.set(keyFor("offset", options), String(count));
    return this;
  }
  range(from: number, to: number, options?: RestReferenced): this {
    this.#state.query.set(keyFor("offset", options), String(from));
    this.#state.query.set(keyFor("limit", options), String(to - from + 1));
    return this;
  }
  select(columns = "*"): this {
    this.#state.query.set("select", compactColumns(columns));
    if (this.#state.method !== "GET" && this.#state.method !== "HEAD") {
      prefer(this.#state.headers, "return=representation");
    }
    return this;
  }
  single(): this {
    this.#state.headers.set("accept", "application/vnd.pgrst.object+json");
    return this;
  }
  maybeSingle(): this {
    // Read as a list; the cardinality is checked here, for every method (as postgrest-js does).
    this.#state.maybeSingle = true;
    return this;
  }
  csv(): this {
    this.#state.headers.set("accept", "text/csv");
    return this;
  }
  geojson(): this {
    this.#state.headers.set("accept", "application/geo+json");
    return this;
  }
  explain(options: ExplainOptions = {}): this {
    const flags = (["analyze", "verbose", "settings", "buffers", "wal"] as const)
      .filter((flag) => options[flag]).join("|");
    const forType = this.#state.headers.get("accept") ?? "application/json";
    this.#state.headers.set(
      "accept",
      `application/vnd.pgrst.plan+${options.format ?? "text"}; for="${forType}"; options=${flags};`,
    );
    return this;
  }
  rollback(): this {
    prefer(this.#state.headers, "tx=rollback");
    return this;
  }
  returns(): this {
    return this;
  }
  throwOnError(): this {
    this.#state.throwOnError = true;
    return this;
  }
  abortSignal(signal: AbortSignal): this {
    this.#state.signal = signal;
    return this;
  }
  setHeader(name: string, value: string): this {
    this.#state.headers.set(name, value);
    return this;
  }
  maxAffected(count: number): this {
    prefer(this.#state.headers, "handling=strict");
    prefer(this.#state.headers, `max-affected=${count}`);
    return this;
  }
  then<A = RestResult<unknown>, B = never>(
    onfulfilled?: ((value: RestResult<unknown>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return send<unknown>(this.#state).then(onfulfilled, onrejected);
  }
}

/** One table's requests. */
export interface RestTableQuery<Row, Insert, Update> {
  /**
   * Read rows: `select("id,title")` returns those columns (typed), `select()` every one;
   * `select("*, author:users(name)")` embeds related rows.
   *
   * @param columns The select list, or `*` (the default).
   * @param options `count` also counts every matching row; `head` skips the rows.
   */
  select<S extends string = "*">(
    columns?: S,
    options?: { count?: RestCount; head?: boolean },
  ): RestQuery<Row, Selected<Row, S>[]>;
  /** Insert one row or several (add `.select()` to get them back). */
  insert(
    values: Insert | Insert[],
    options?: { count?: RestCount; defaultToNull?: boolean },
  ): RestQuery<Row, null>;
  /** Insert, or update the rows that collide on `onConflict` (the primary key by default). */
  upsert(
    values: Insert | Insert[],
    options?: {
      onConflict?: string;
      ignoreDuplicates?: boolean;
      count?: RestCount;
      defaultToNull?: boolean;
    },
  ): RestQuery<Row, null>;
  /** Update the rows the filters match (a filter is required). */
  update(values: Update, options?: { count?: RestCount }): RestQuery<Row, null>;
  /** Delete the rows the filters match (a filter is required). */
  delete(options?: { count?: RestCount }): RestQuery<Row, null>;
}

/** `rpc()`'s options. */
export interface RpcOptions {
  /** Send no body back (`HEAD`). */
  head?: boolean;
  /** Call with `GET` (arguments in the query; the function must not write). */
  get?: boolean;
  /** Count the result's rows. */
  count?: RestCount;
}

/** A REST client: `from(table)`, `rpc(fn)`, `schema(name)`. */
export interface RestClient {
  /** The requests for `table`. */
  from<K extends RestTableName>(
    table: K,
  ): RestTableQuery<
    RestTableShapeOf<K>["Row"],
    RestTableShapeOf<K>["Insert"],
    RestTableShapeOf<K>["Update"]
  >;
  /** Call a function: `/rpc/<fn>`. */
  rpc<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
    options?: RpcOptions,
  ): RestQuery<Record<string, unknown>, T>;
  /** The same client on another exposed schema. */
  schema(name: string): RestClient;
}

/** The default base URL: the app's `basePath` plus `/rest/v1`. */
function defaultUrl(): string {
  return ((globalThis as { __denextBasePath?: string }).__denextBasePath ?? "") + "/rest/v1";
}

/** `columns="a","b"` for an array body (the union of its objects' keys). */
function setColumns(query: URLSearchParams, values: unknown): void {
  if (!Array.isArray(values)) return;
  const keys = new Set<string>();
  for (const row of values) for (const key of Object.keys(row ?? {})) keys.add(key);
  if (keys.size) query.set("columns", [...keys].map((k) => `"${k}"`).join(","));
}

/** Makes a request's state for a method (and body). */
type MakeState = (method: RequestState["method"], body?: unknown) => RequestState;

/** The state of a write: `count`, `missing=default`, `columns=`. */
function writeState(
  make: MakeState,
  method: RequestState["method"],
  values: unknown,
  options: { count?: RestCount; defaultToNull?: boolean },
): RequestState {
  const state = make(method, values);
  if (options.count) prefer(state.headers, `count=${options.count}`);
  if (options.defaultToNull === false) prefer(state.headers, "missing=default");
  if (method === "POST") setColumns(state.query, values);
  return state;
}

/** The requests of one table. */
function tableQuery(make: MakeState): RestTableQuery<never, never, never> {
  const api = {
    select(columns?: string, options: { count?: RestCount; head?: boolean } = {}) {
      const state = make(options.head ? "HEAD" : "GET");
      if (options.count) prefer(state.headers, `count=${options.count}`);
      return new Builder(state).select(columns);
    },
    insert(values: unknown, options: { count?: RestCount; defaultToNull?: boolean } = {}) {
      return new Builder(writeState(make, "POST", values, options));
    },
    upsert(
      values: unknown,
      options: {
        onConflict?: string;
        ignoreDuplicates?: boolean;
        count?: RestCount;
        defaultToNull?: boolean;
      } = {},
    ) {
      const state = writeState(make, "POST", values, options);
      prefer(
        state.headers,
        `resolution=${options.ignoreDuplicates ? "ignore" : "merge"}-duplicates`,
      );
      if (options.onConflict !== undefined) state.query.set("on_conflict", options.onConflict);
      return new Builder(state);
    },
    update(values: unknown, options: { count?: RestCount } = {}) {
      return new Builder(writeState(make, "PATCH", values, options));
    },
    delete(options: { count?: RestCount } = {}) {
      return new Builder(writeState(make, "DELETE", undefined, options));
    },
  };
  return api as unknown as RestTableQuery<never, never, never>;
}

/** The query of an RPC call made with GET / HEAD: each argument as a parameter. */
function rpcQuery(args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    query.append(name, Array.isArray(value) ? `{${value.join(",")}}` : valueText(value));
  }
  return query;
}

/**
 * A client for `backend({ rest })`'s routes — the API of `@supabase/supabase-js`'s `from()`,
 * `rpc()` and `schema()`. Requests carry the page's cookies, so row-level security sees the
 * signed-in user.
 *
 * ```ts
 * import "./.denext/rest.ts"; // the generated types
 * import { restClient } from "@denext/backend/client";
 * const rest = restClient();
 * const { data, error } = await rest.from("notes").select("id,body,author:users(name)")
 *   .order("id").limit(20);
 * ```
 *
 * @param options Base URL, extra headers, `fetch`, schema.
 * @returns The client.
 */
export function restClient(options: RestClientOptions = {}): RestClient {
  const base = (options.url ?? defaultUrl()).replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const state = (
    path: string,
    method: RequestState["method"],
    body?: unknown,
    query = new URLSearchParams(),
  ): RequestState => ({
    method,
    url: `${base}/${path}`,
    query,
    headers: new Headers(options.headers),
    body,
    ...(options.schema ? { schema: options.schema } : {}),
    fetch: doFetch,
    maybeSingle: false,
    throwOnError: false,
  });
  return {
    from(table: string) {
      return tableQuery((method, body) => state(encodeURIComponent(table), method, body));
    },
    rpc(fn: string, args: Record<string, unknown> = {}, rpcOptions: RpcOptions = {}) {
      const path = `rpc/${encodeURIComponent(fn)}`;
      const read = rpcOptions.head || rpcOptions.get;
      const request = read
        ? state(path, rpcOptions.head ? "HEAD" : "GET", undefined, rpcQuery(args))
        : state(path, "POST", args);
      if (rpcOptions.count) prefer(request.headers, `count=${rpcOptions.count}`);
      return new Builder(request);
    },
    schema(name: string) {
      return restClient({ ...options, schema: name });
    },
  } as unknown as RestClient;
}

/**
 * `restClient().from(table)` with the default options.
 *
 * @param table The table.
 * @returns Its requests.
 */
export function from<K extends RestTableName>(
  table: K,
): RestTableQuery<
  RestTableShapeOf<K>["Row"],
  RestTableShapeOf<K>["Insert"],
  RestTableShapeOf<K>["Update"]
> {
  return restClient().from(table);
}

/**
 * `restClient().rpc(fn, args, options)` with the default options.
 *
 * @param fn The function.
 * @param args Its arguments.
 * @param options `head`, `get`, `count`.
 * @returns The request.
 */
export function rpc<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
  options?: RpcOptions,
): RestQuery<Record<string, unknown>, T> {
  return restClient().rpc<T>(fn, args, options);
}
