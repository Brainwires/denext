// The browser half of auto-REST: `from("table")` builds a request to `backend({ rest })`'s
// routes — `select().eq().order().limit()`, `insert()`, `update().eq()`, `delete().eq()` — and
// resolves to `{ data, error, count, status }`. The builder's shape follows supabase-js's loosely;
// it is not a drop-in for it. Row types come from `.denext/rest.ts` (generated from the live
// catalog), registered on `RegisteredRest`. No server imports: safe to bundle for the browser.

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
  : RestTableShape;

/** The column names a `select("a, b")` string lists (`"a" | "b"`), spaces trimmed. */
export type SelectColumns<S extends string> = S extends `${infer A},${infer B}`
  ? SelectColumns<A> | SelectColumns<B>
  : S extends ` ${infer R}` ? SelectColumns<R>
  : S extends `${infer R} ` ? SelectColumns<R>
  : S;

/** The row shape `select(columns)` returns: the listed columns of `Row`, or all of it for `*`. */
export type Selected<Row, S extends string> = "*" extends SelectColumns<S> ? Row
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

/** What a request resolves to: never a rejection, so check `error`. */
export interface RestResult<T> {
  /** The rows (or row, after `single()`); `null` on error or for a write without `select()`. */
  data: T | null;
  /** The error, or `null`. */
  error: RestClientError | null;
  /** Every matching row's count, when `count: "exact"` was asked for. */
  count: number | null;
  /** The HTTP status. */
  status: number;
}

/** Options for {@linkcode restClient}. */
export interface RestClientOptions {
  /** The routes' base URL (default: `<basePath>/rest/v1` on the page's origin). */
  url?: string;
  /** Extra headers on every request (`Authorization: Bearer …` for a native session). */
  headers?: HeadersInit;
  /** The `fetch` to use (default: the global one). */
  fetch?: typeof fetch;
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

/** What one request is made of. */
interface RequestState {
  readonly method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
  readonly query: URLSearchParams;
  readonly body?: unknown;
  representation: boolean;
  count: boolean;
  single: boolean;
  range?: [number, number];
}

/** The operators `not()` negates. */
export type RestNegatable = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is";

/**
 * A request being built: chain filters, ordering and paging, then `await` it.
 *
 * @typeParam Row The table's row.
 * @typeParam Result What `data` holds.
 */
export interface RestQuery<Row, Result> extends PromiseLike<RestResult<Result>> {
  /** `column = value`. */
  eq<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column <> value`. */
  neq<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column > value`. */
  gt<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column >= value`. */
  gte<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column < value`. */
  lt<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column <= value`. */
  lte<C extends keyof Row & string>(column: C, value: Row[C]): RestQuery<Row, Result>;
  /** `column LIKE pattern` (`%` or `*` match any run). */
  like<C extends keyof Row & string>(column: C, pattern: string): RestQuery<Row, Result>;
  /** `column ILIKE pattern` (case-insensitive). */
  ilike<C extends keyof Row & string>(column: C, pattern: string): RestQuery<Row, Result>;
  /** `column IS NULL | TRUE | FALSE`. */
  is<C extends keyof Row & string>(column: C, value: null | boolean): RestQuery<Row, Result>;
  /** `column IN (values…)`. */
  in<C extends keyof Row & string>(column: C, values: readonly Row[C][]): RestQuery<Row, Result>;
  /** Negate one operator: `not("status", "eq", "done")`. */
  not<C extends keyof Row & string>(
    column: C,
    op: RestNegatable,
    value: Row[C] | null,
  ): RestQuery<Row, Result>;
  /** Order by a column (call again for a tie-breaker). */
  order<C extends keyof Row & string>(
    column: C,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): RestQuery<Row, Result>;
  /** Return at most `count` rows (the server caps it at its `maxRows`). */
  limit(count: number): RestQuery<Row, Result>;
  /** Skip `count` rows. */
  offset(count: number): RestQuery<Row, Result>;
  /** Rows `from` … `to`, inclusive, zero-based (a `Range` header). */
  range(from: number, to: number): RestQuery<Row, Result>;
  /**
   * After `insert` / `update` / `delete`: return the written rows (their `columns`).
   *
   * @param columns Comma-separated columns, or `*` (the default).
   * @returns The request, now resolving to the rows.
   */
  select<S extends string = "*">(columns?: S): RestQuery<Row, Selected<Row, S>[]>;
  /** Expect exactly one row: `data` is that row, and zero or several rows are an error. */
  single(): RestQuery<Row, Result extends readonly (infer E)[] ? E : Result>;
}

/** The request's headers: `Prefer`, `Accept`, `Range`, `Content-Type` over the client's own. */
function headersOf(state: RequestState, base: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  const write = state.method !== "GET" && state.method !== "HEAD";
  const prefer = [
    ...(write && state.representation ? ["return=representation"] : []),
    ...(state.count ? ["count=exact"] : []),
  ];
  if (prefer.length) headers.set("prefer", prefer.join(", "));
  if (state.single) headers.set("accept", "application/vnd.pgrst.object+json");
  if (state.range) headers.set("range", `${state.range[0]}-${state.range[1]}`);
  if (state.body !== undefined) headers.set("content-type", "application/json");
  return headers;
}

/** A response → the result: rows (or `null` with no body), the count, or the error. */
async function resultOf<Result>(res: Response, head: boolean): Promise<RestResult<Result>> {
  const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
  const count = range ? Number(range[1]) : null;
  const text = head ? "" : await res.text();
  if (!res.ok) return { data: null, error: errorOf(res.status, text), count, status: res.status };
  const data = text === "" ? null : JSON.parse(text) as Result;
  return { data, error: null, count, status: res.status };
}

/** Send a request, answering a network failure as a result too. */
async function send<Result>(
  url: string,
  options: RestClientOptions,
  state: RequestState,
): Promise<RestResult<Result>> {
  const query = state.query.toString();
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(query ? `${url}?${query}` : url, {
      method: state.method,
      credentials: "same-origin",
      headers: headersOf(state, options.headers),
      ...(state.body !== undefined ? { body: JSON.stringify(state.body) } : {}),
    });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    const failure = new RestClientError("network_error", 0, message);
    return { data: null, error: failure, count: null, status: 0 };
  }
  return await resultOf<Result>(res, state.method === "HEAD");
}

/** Build a request over `state` (each method records into it and returns the same request). */
function restQuery<Row, Result>(
  url: string,
  options: RestClientOptions,
  state: RequestState,
): RestQuery<Row, Result> {
  // The builder only changes `state`; its type parameters are re-read at each step.
  // deno-lint-ignore no-explicit-any
  const query: RestQuery<any, any> = {} as RestQuery<any, any>;
  const filter = (op: string) => (column: string, value: unknown) => {
    state.query.append(column, `${op}.${valueText(value)}`);
    return query;
  };
  const set = (name: string) => (count: number) => {
    state.query.set(name, String(count));
    return query;
  };
  Object.assign(query, {
    eq: filter("eq"),
    neq: filter("neq"),
    gt: filter("gt"),
    gte: filter("gte"),
    lt: filter("lt"),
    lte: filter("lte"),
    like: filter("like"),
    ilike: filter("ilike"),
    is: filter("is"),
    in: (column: string, values: readonly unknown[]) => {
      state.query.append(column, `in.(${values.map(listItem).join(",")})`);
      return query;
    },
    not: (column: string, op: RestNegatable, value: unknown) => filter(`not.${op}`)(column, value),
    order: (column: string, order: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
      const nulls = order.nullsFirst === undefined
        ? ""
        : order.nullsFirst
        ? ".nullsfirst"
        : ".nullslast";
      const term = `${column}.${order.ascending === false ? "desc" : "asc"}${nulls}`;
      const previous = state.query.get("order");
      state.query.set("order", previous ? `${previous},${term}` : term);
      return query;
    },
    limit: set("limit"),
    offset: set("offset"),
    range: (from: number, to: number) => {
      state.range = [from, to];
      return query;
    },
    select: (columns?: string) => {
      if (columns) state.query.set("select", columns);
      state.representation = true;
      return query;
    },
    single: () => {
      state.single = true;
      return query;
    },
    then: (
      onfulfilled?: ((value: RestResult<Result>) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => send<Result>(url, options, state).then(onfulfilled, onrejected),
  });
  return query as RestQuery<Row, Result>;
}

/** A non-2xx answer → the client error. */
function errorOf(status: number, text: string): RestClientError {
  try {
    const e = JSON.parse(text) as {
      code: string;
      message: string;
      details?: string;
      hint?: string;
    };
    return new RestClientError(e.code, status, e.message, e.details ?? null, e.hint ?? null);
  } catch {
    return new RestClientError("http_error", status, text || `HTTP ${status}`);
  }
}

/** One table's requests. */
export interface RestTableQuery<Row, Insert, Update> {
  /**
   * Read rows: `select("id,title")` returns those columns (typed), `select()` every one.
   *
   * @param columns Comma-separated columns, or `*` (the default).
   * @param options `count: "exact"` also counts every matching row; `head` skips the rows.
   */
  select<S extends string = "*">(
    columns?: S,
    options?: { count?: "exact"; head?: boolean },
  ): RestQuery<Row, Selected<Row, S>[]>;
  /** Insert one row or several (add `.select()` to get them back). */
  insert(values: Insert | Insert[]): RestQuery<Row, null>;
  /** Update the rows the filters match (a filter is required). */
  update(values: Update): RestQuery<Row, null>;
  /** Delete the rows the filters match (a filter is required). */
  delete(): RestQuery<Row, null>;
}

/** A REST client: `from(table)`. */
export interface RestClient {
  /** The requests for `table`. */
  from<K extends RestTableName>(
    table: K,
  ): RestTableQuery<
    RestTableShapeOf<K>["Row"],
    RestTableShapeOf<K>["Insert"],
    RestTableShapeOf<K>["Update"]
  >;
}

/** The default base URL: the app's `basePath` plus `/rest/v1`. */
function defaultUrl(): string {
  return ((globalThis as { __denextBasePath?: string }).__denextBasePath ?? "") + "/rest/v1";
}

/**
 * A client for `backend({ rest })`'s routes. Requests carry the page's cookies, so row-level
 * security sees the signed-in user.
 *
 * ```ts
 * import "./.denext/rest.ts"; // the generated row types
 * import { restClient } from "@denext/backend/client";
 * const rest = restClient();
 * const { data, error } = await rest.from("notes").select("id,body").order("id").limit(20);
 * ```
 *
 * @param options Base URL, extra headers, `fetch`.
 * @returns The client.
 */
export function restClient(options: RestClientOptions = {}): RestClient {
  const base = (options.url ?? defaultUrl()).replace(/\/+$/, "");
  const make = (
    table: string,
    method: RequestState["method"],
    body?: unknown,
    extra: Partial<RequestState> = {},
  ) =>
    restQuery(`${base}/${encodeURIComponent(table)}`, options, {
      method,
      query: new URLSearchParams(),
      body,
      representation: false,
      count: false,
      single: false,
      ...extra,
    });
  return {
    from(table) {
      return {
        select(columns, selectOptions = {}) {
          const query = make(table, selectOptions.head ? "HEAD" : "GET", undefined, {
            count: selectOptions.count === "exact",
          });
          return query.select(columns);
        },
        insert: (values) => make(table, "POST", values),
        update: (values) => make(table, "PATCH", values),
        delete: () => make(table, "DELETE"),
      } as RestTableQuery<never, never, never>;
    },
  } as RestClient;
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
