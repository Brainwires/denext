// Auto-REST: `backend({ rest })` serves the tables of one Postgres schema PostgREST-style under
// `/rest/v1/<table>` — GET with filters, ordering and paging, POST inserts, PATCH and DELETE
// with filters — every statement run through `db()`, so row-level security scopes it to the
// request's user (or `anon`). Only tables the `anon` / `authenticated` roles hold a privilege on
// get a route; the statements are built in `rest-query.ts` from the catalog in `rest-catalog.ts`.
//
// A write carrying cookies follows denext's Server Actions rule (`csrf()`): a cross-site one is
// refused. A native app's bearer token (`Authorization: Bearer nat_…`), which `auth()` reads
// instead of the cookie, needs no such check.

import {
  csrf,
  isApiError,
  type PluginContext,
  readCappedBody,
  type SqlRow,
  STALLED,
  TOO_LARGE,
} from "@denext/denext/server";
import { db, rlsReady } from "./postgres.ts";
import { start } from "./rls.ts";
import { readRestCatalog, type RestCatalog, type RestTable } from "./rest-catalog.ts";
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  countParam,
  RestError,
  type RestStatement,
} from "./rest-query.ts";
import { IDENTIFIER } from "./realtime-shared.ts";
import { positiveOption } from "./options.ts";
import { writeRestTypes } from "./rest-codegen.ts";

/** `backend({ rest })`: auto-REST over a Postgres schema. */
export interface RestOptions {
  /** The schema whose tables are served (default `"public"`). */
  schema?: string;
  /**
   * The tables to serve, by name, or `"*"` (the default) for every table and view of the
   * schema that the `anon` or `authenticated` role holds a privilege on. A listed table those
   * roles cannot reach gets no route either.
   */
  tables?: string[] | "*";
  /** Where the routes live, app-relative (default `"/rest/v1"`). */
  basePath?: string;
  /** The most rows one read returns, whatever `limit` asks for (default 1000). */
  maxRows?: number;
  /** The largest request body accepted, in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Each request's `statement_timeout`, in milliseconds (default 8000). */
  statementTimeout?: number;
}

/** Validated auto-REST options. */
export interface ResolvedRest {
  /** The schema. */
  schema: string;
  /** The tables, or `"*"`. */
  tables: string[] | "*";
  /** The route prefix (leading `/`, no trailing one). */
  basePath: string;
  /** The read cap. */
  maxRows: number;
  /** The body cap. */
  maxBodyBytes: number;
  /** The statement timeout (ms). */
  statementTimeout: number;
}

/**
 * Validate `backend({ rest })` and apply the defaults.
 *
 * @param o The options.
 * @returns The resolved options.
 * @throws {TypeError} For a bad schema, table list, base path or limit.
 */
export function resolveRest(o: RestOptions): ResolvedRest {
  const schema = o.schema ?? "public";
  if (typeof schema !== "string" || !IDENTIFIER.test(schema)) {
    throw new TypeError(
      `backend(): rest.schema ${JSON.stringify(schema)} is not a plain identifier`,
    );
  }
  const tables = o.tables ?? "*";
  if (tables !== "*" && (!Array.isArray(tables) || tables.some((t) => typeof t !== "string"))) {
    throw new TypeError(`backend(): rest.tables must be "*" or a list of table names`);
  }
  const basePath = (o.basePath ?? "/rest/v1").replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath === "") {
    throw new TypeError(`backend(): rest.basePath must be an absolute path such as "/rest/v1"`);
  }
  return {
    schema,
    tables,
    basePath,
    maxRows: positiveOption(o.maxRows, 1000, "backend(): rest.maxRows"),
    maxBodyBytes: positiveOption(o.maxBodyBytes, 1024 * 1024, "backend(): rest.maxBodyBytes"),
    statementTimeout: positiveOption(o.statementTimeout, 8000, "backend(): rest.statementTimeout"),
  };
}

/** How long `denext dev` waits before re-reading the catalog for a table it does not know. */
const DEV_REFRESH_MS = 2000;

/**
 * The catalog, read once and shared; a failed read is retried by the next request. Under
 * `denext dev` a request for a table the catalog lacks re-reads it (at most every 2 s), so a
 * table created while the server runs gets its route.
 */
export class RestCatalogCache {
  #pending: Promise<RestCatalog> | undefined;
  #readAt = 0;
  readonly #load: () => Promise<RestCatalog>;
  readonly #dev: boolean;

  /**
   * A cache over `load`.
   *
   * @param load Reads the catalog.
   * @param dev Re-read on a miss (`denext dev`).
   */
  constructor(load: () => Promise<RestCatalog>, dev: boolean) {
    this.#load = load;
    this.#dev = dev;
  }

  /** The catalog (read on first use). */
  get(): Promise<RestCatalog> {
    if (!this.#pending) {
      this.#readAt = Date.now();
      this.#pending = this.#load();
      this.#pending.catch(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  /** One exposed table, or `undefined`. */
  async table(name: string): Promise<RestTable | undefined> {
    const found = (await this.get()).get(name);
    if (found || !this.#dev || Date.now() - this.#readAt < DEV_REFRESH_MS) return found;
    this.#pending = undefined;
    return (await this.get()).get(name);
  }
}

/**
 * The catalog loader the plugin uses: the RLS roles first (the privilege checks name them),
 * then the connecting role's view of `pg_catalog`.
 *
 * @param rest The resolved options.
 * @returns The loader.
 */
function catalogLoader(rest: ResolvedRest): () => Promise<RestCatalog> {
  return () => rlsReady().then(() => readRestCatalog(db.service(), rest.schema, rest.tables));
}

/** The `set_config` that bounds every statement after it in the transaction. */
const TIMEOUT_SQL = "select set_config('statement_timeout', $1, true)";

/**
 * Run one statement through `db()` — as the request's user, or `anon` — inside a transaction
 * that first bounds it with `statement_timeout`. `check` sees the first row before COMMIT; a
 * throw there rolls the write back.
 */
async function runScoped(
  statement: RestStatement,
  timeout: number,
  check?: (row: SqlRow | undefined) => void,
): Promise<SqlRow | undefined> {
  return await db().begin((tx) => {
    const bounded = start(tx.unsafe(TIMEOUT_SQL, [String(timeout)]));
    const rows = start(tx.unsafe(statement.text, statement.params));
    return Promise.all([bounded, rows]).then(([, result]) => {
      const row = [...result][0];
      check?.(row);
      return row;
    });
  });
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** A PostgREST-shaped JSON error. */
function errorBody(code: string, message: string, details: string | null, hint: string | null) {
  return JSON.stringify({ code, message, details, hint });
}

/** The HTTP status for a SQLSTATE, after PostgREST's table. */
export function statusForSqlState(code: string): number {
  if (code === "23503" || code === "23505") return 409;
  if (code === "42501") return 403;
  if (code === "42P01" || code === "42883") return 404;
  if (code === "57014") return 504;
  if (code === "25006") return 405;
  if (code === "P0001") return 400;
  const exact: Record<string, number> = { "08": 503, "53": 503, "54": 413, "28": 403 };
  const head = code.slice(0, 2);
  if (head in exact) return exact[head];
  if (head === "0L" || head === "0P") return 403;
  if (head === "22" || head === "23" || head === "42") return 400;
  return 500;
}

/** Anything thrown → the error response. */
function errorResponse(error: unknown): Response {
  const json = (status: number, body: string) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  if (error instanceof RestError) {
    return json(error.status, errorBody(error.code, error.message, error.details, error.hint));
  }
  if (isApiError(error)) {
    return json(error.status, errorBody(error.code, error.message, null, null));
  }
  const pg = error as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) {
    const status = statusForSqlState(pg.code);
    if (status < 500 || status === 504) {
      const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
      return json(status, errorBody(pg.code, String(pg.message), text(pg.detail), text(pg.hint)));
    }
    console.error("[@denext/backend] REST statement failed", error);
    return json(status, errorBody(pg.code, "database error", null, null));
  }
  console.error("[@denext/backend] REST request failed", error);
  return json(503, errorBody("PGRST001", "the database is unavailable", null, null));
}

// ── Request parsing ──────────────────────────────────────────────────────────

/** What `Prefer` asked for. */
interface Preferences {
  representation: boolean;
  count: boolean;
  applied: string[];
}

/** Read `Prefer: return=…, count=exact`. */
function preferencesOf(request: Request): Preferences {
  const tokens = (request.headers.get("prefer") ?? "").split(",").map((t) => t.trim());
  const applied: string[] = [];
  let representation = false;
  let count = false;
  for (const token of tokens) {
    if (token === "return=representation") representation = true;
    else if (token === "count=exact") count = true;
    else if (token !== "return=minimal") continue;
    applied.push(token);
  }
  return { representation, count, applied };
}

/** `Range: 0-24` (or `items=0-24`) → offset and length, when present and well-formed. */
function rangeOf(request: Request): { offset: number; length?: number } | undefined {
  const match = /^\s*(?:items=)?(\d{1,9})-(\d{0,9})\s*$/.exec(request.headers.get("range") ?? "");
  if (!match) return undefined;
  const from = Number(match[1]);
  if (match[2] === "") return { offset: from };
  const to = Number(match[2]);
  if (to < from) throw new RestError(416, "PGRST103", "the requested range is not satisfiable");
  return { offset: from, length: to - from + 1 };
}

/** Whether the client asked for one object instead of an array. */
function wantsObject(request: Request): boolean {
  return /application\/vnd\.pgrst\.object\+json/i.test(request.headers.get("accept") ?? "");
}

/** Exactly one row, or the 406 PostgREST answers. */
function requireOne(row: SqlRow | undefined): void {
  const n = Number(row?.n ?? 0);
  if (n !== 1) {
    throw new RestError(
      406,
      "PGRST116",
      "JSON object requested, multiple (or no) rows returned",
      `The result contains ${n} rows`,
    );
  }
}

/** The request's JSON body, capped. */
async function bodyOf(request: Request, max: number): Promise<unknown> {
  const type = request.headers.get("content-type");
  if (type !== null && !/^application\/json\b/i.test(type.trim())) {
    throw new RestError(415, "PGRST102", "the body must be application/json");
  }
  const bytes = await readCappedBody(request, max);
  if (bytes === TOO_LARGE) throw new RestError(413, "PGRST102", "the request body is too large");
  if (bytes === STALLED) throw new RestError(408, "PGRST102", "the request body stalled");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RestError(400, "PGRST102", "the body is not valid JSON");
  }
}

/** A native app's bearer session (`auth()` reads it, never the cookie). */
function nativeBearer(request: Request): boolean {
  return /^bearer\s+nat_/i.test(request.headers.get("authorization") ?? "");
}

const checkCsrf = csrf();

/** Refuse a cross-site write that rides the page's cookies (the Server Actions rule). */
async function guardWrite(request: Request): Promise<void> {
  if (nativeBearer(request)) return;
  await checkCsrf({
    request,
    params: {},
    ctx: {},
    method: request.method as "POST",
  });
}

// ── Responses ────────────────────────────────────────────────────────────────

/** The JSON response for a row set (`body` is Postgres's JSON array text). */
function rowsResponse(
  row: SqlRow | undefined,
  status: number,
  headers: Headers,
  object: boolean,
  head: boolean,
): Response {
  const text = String(row?.body ?? "[]");
  headers.set(
    "content-type",
    object ? "application/vnd.pgrst.object+json; charset=utf-8" : "application/json; charset=utf-8",
  );
  // `json_agg` prints exactly `[…]`: the one element is the text between the brackets.
  const body = object ? text.slice(1, -1).trim() : text;
  return new Response(head ? null : body, { status, headers });
}

/** Common headers: never cached (the rows are this user's), and what `Prefer` applied. */
function baseHeaders(prefs: Preferences): Headers {
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (prefs.applied.length) headers.set("preference-applied", prefs.applied.join(", "));
  return headers;
}

/** The page a read asks for: `Range`, else `offset`; `limit`, the range's length and `maxRows`. */
function pageOf(
  rest: ResolvedRest,
  request: Request,
  query: URLSearchParams,
): { offset: number; limit: number } {
  const range = rangeOf(request);
  const limits = [
    rest.maxRows,
    range?.length ?? rest.maxRows,
    countParam(query.get("limit"), "limit") ?? rest.maxRows,
  ];
  return {
    offset: range?.offset ?? countParam(query.get("offset"), "offset") ?? 0,
    limit: Math.min(...limits),
  };
}

/** `Content-Range` and the status for a page of `n` rows out of `total` (when counted). */
function rangeOutcome(
  offset: number,
  n: number,
  total: number | undefined,
): { contentRange: string; status: number } {
  if (total !== undefined && n === 0 && offset > 0 && offset >= total) {
    throw new RestError(
      416,
      "PGRST103",
      "the requested range is not satisfiable",
      `An offset of ${offset} was requested, but there are only ${total} rows.`,
    );
  }
  const span = n === 0 ? "*" : `${offset}-${offset + n - 1}`;
  return {
    contentRange: `${span}/${total ?? "*"}`,
    status: total !== undefined && n < total ? 206 : 200,
  };
}

async function read(
  rest: ResolvedRest,
  table: RestTable,
  request: Request,
  query: URLSearchParams,
): Promise<Response> {
  const prefs = preferencesOf(request);
  prefs.applied = prefs.applied.filter((p) => p.startsWith("count="));
  const { offset, limit } = pageOf(rest, request, query);
  const object = wantsObject(request);
  const statement = buildSelect(table, query, { offset, limit, count: prefs.count });
  const row = await runScoped(statement, rest.statementTimeout, object ? requireOne : undefined);
  const total = prefs.count ? Number(row?.total ?? 0) : undefined;
  const { contentRange, status } = rangeOutcome(offset, Number(row?.n ?? 0), total);
  const headers = baseHeaders(prefs);
  headers.set("content-range", contentRange);
  return rowsResponse(row, status, headers, object, request.method === "HEAD");
}

/** The statement for a write: a DELETE, or an INSERT / UPDATE from the JSON body. */
async function writeStatement(
  rest: ResolvedRest,
  table: RestTable,
  request: Request,
  query: URLSearchParams,
  representation: boolean,
): Promise<RestStatement> {
  const options = { representation };
  if (request.method === "DELETE") return buildDelete(table, query, options);
  const body = await bodyOf(request, rest.maxBodyBytes);
  return request.method === "POST"
    ? buildInsert(table, query, body, options)
    : buildUpdate(table, query, body, options);
}

async function write(
  rest: ResolvedRest,
  table: RestTable,
  request: Request,
  query: URLSearchParams,
): Promise<Response> {
  await guardWrite(request);
  const prefs = preferencesOf(request);
  // Without RETURNING (which needs SELECT on the rows) nothing is counted.
  if (!prefs.representation) prefs.applied = prefs.applied.filter((p) => p !== "count=exact");
  const object = prefs.representation && wantsObject(request);
  const statement = await writeStatement(rest, table, request, query, prefs.representation);
  const row = await runScoped(statement, rest.statementTimeout, object ? requireOne : undefined);
  const headers = baseHeaders(prefs);
  const created = request.method === "POST";
  if (!prefs.representation) return new Response(null, { status: created ? 201 : 204, headers });
  if (prefs.count) headers.set("content-range", `*/${Number(row?.n ?? 0)}`);
  return rowsResponse(row, created ? 201 : 200, headers, object, false);
}

/** The methods a table route answers. */
const ALLOW = "GET, HEAD, POST, PATCH, DELETE";

/** The exposed table a path names (`<prefix><table>`), or a 404. */
async function tableOf(
  rest: ResolvedRest,
  catalog: RestCatalogCache,
  segment: string,
): Promise<RestTable> {
  let name = "";
  try {
    name = decodeURIComponent(segment);
  } catch {
    // A malformed escape names no table.
  }
  const table = name === "" || name.includes("/") ? undefined : await catalog.table(name);
  if (!table) {
    throw new RestError(
      404,
      "PGRST205",
      `Could not find the table '${rest.schema}.${name.slice(0, 64)}'`,
    );
  }
  return table;
}

/** The methods each kind of route takes. */
const READS = new Set(["GET", "HEAD"]);
const WRITES = new Set(["POST", "PATCH", "DELETE"]);

/**
 * The auto-REST request handler. Answers only paths under `rest.basePath`; everything else
 * passes (`null`).
 */
function restHandler(
  rest: ResolvedRest,
  catalog: RestCatalogCache,
): (request: Request) => Promise<Response | null> {
  const prefix = `${rest.basePath}/`;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    try {
      const table = await tableOf(rest, catalog, url.pathname.slice(prefix.length));
      if (READS.has(request.method)) return await read(rest, table, request, url.searchParams);
      if (WRITES.has(request.method)) return await write(rest, table, request, url.searchParams);
      return new Response(null, { status: 405, headers: { allow: ALLOW } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Wire auto-REST into the plugin: the request handler, the catalog read at startup (`dev`,
 * `prod`; a failure is retried by the first request), and the prepare step that writes the
 * row types to `.denext/rest.ts`.
 *
 * @param ctx The plugin context.
 * @param rest The resolved options.
 */
export function setupRest(ctx: PluginContext, rest: ResolvedRest): void {
  const catalog = new RestCatalogCache(catalogLoader(rest), ctx.mode === "dev");
  ctx.addRequestHandler(restHandler(rest, catalog));
  ctx.addPrepareStep(({ outDir }) => writeRestTypes(outDir, rest, () => catalog.get()));
  if (ctx.mode === "dev" || ctx.mode === "prod") {
    catalog.get().catch((error) => {
      console.warn(
        `[@denext/backend] rest: could not read the catalog yet (retried on the first request): ${
          (error as Error)?.message ?? error
        }`,
      );
    });
  }
}
