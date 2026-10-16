// Auto-REST: `backend({ rest })` serves the tables, views and functions of the exposed Postgres
// schemas PostgREST-style under `/rest/v1/<table>` and `/rest/v1/rpc/<function>` — reads with
// embedded resources, filters, logic trees, ordering, paging and counts; inserts, upserts,
// updates and deletes; function calls — every statement run through `db()`, so row-level
// security scopes it to the request's user (or `anon`). Only relations and functions the `anon`
// / `authenticated` roles hold a privilege on are reachable; the statements are built in
// `rest-query.ts` from the catalog in `rest-catalog.ts`. The wire format follows PostgREST 12,
// so the stock `@supabase/supabase-js` client works against these routes unchanged.
//
// A write carrying cookies follows denext's Server Actions rule (`csrf()`): a cross-site one is
// refused. A request whose identity came from a token instead — a native app's
// `Authorization: Bearer nat_…` (recognized by `auth()`'s own parser), a Supabase access token,
// or the secret key — needs no such check: the exemption never covers a request whose identity
// comes from the cookie.
//
// The routes share the app's Postgres pool, so at most `maxConcurrent` REST statements run at
// once (a request past that waits briefly, then gets a 503 with `Retry-After`), each under a
// short `statement_timeout`; a read (GET / HEAD) runs in a READ ONLY transaction, as PostgREST's
// do. `Prefer: count=exact` (a full count) is for signed-in users only unless `exactCount` says
// otherwise. Each client has a request budget (`rateLimit`, `rest-limit.ts`): past it, a 429
// before any statement.

import {
  csrf,
  nativeBearerToken,
  type PluginContext,
  type SqlClient,
  type SqlRow,
} from "@denext/denext/server";
import { db, rlsReady } from "./postgres.ts";
import { isIdentityError, type RequestIdentity, resolveIdentity } from "./identity.ts";
import { start } from "./rls.ts";
import {
  readRestCatalog,
  type RestCatalog,
  type RestFunction,
  type RestTable,
  type SkippedRelation,
  tableIn,
} from "./rest-catalog.ts";
import {
  applyQuery,
  type BodyShape,
  buildDelete,
  buildInsert,
  buildPlannedCount,
  buildPut,
  buildRpc,
  buildRpcPlannedCount,
  buildSelect,
  buildUpdate,
  countParam,
  functionSource,
  type PlanNode,
  planOf,
  resolveFunction,
  type RestStatement,
  type RpcInput,
  tableSource,
  type WriteReturn,
} from "./rest-query.ts";
import { parseNameList, parseSelect, RestError, type SelectItem } from "./rest-parse.ts";
import {
  bodyOf,
  errorResponse,
  type Media,
  mediaOfRequest,
  type Preferences,
  preferencesOf,
  profileOf,
  rangeOf,
  requireOne,
} from "./rest-http.ts";
import { csvFromJson } from "./rest-format.ts";
import { openApiContribution, openApiDocument } from "./rest-openapi.ts";
import { IDENTIFIER } from "./realtime-shared.ts";
import { positiveOption } from "./options.ts";
import { writeRestTypes } from "./rest-codegen.ts";
import {
  type ResolvedRestRateLimit,
  resolveRestRateLimit,
  RestLimiter,
  type RestRateLimitOptions,
} from "./rest-limit.ts";

export { statusForSqlState } from "./rest-http.ts";

/** `backend({ rest })`: auto-REST over Postgres schemas. */
export interface RestOptions {
  /** The schema whose tables are served (default `"public"`); `schemas` lists several. */
  schema?: string;
  /**
   * The schemas served, the default first (`Accept-Profile` / `Content-Profile` pick another,
   * supabase-js's `schema("api")`). Overrides `schema`.
   */
  schemas?: string[];
  /**
   * The relations to serve, by name (`"notes"`, or `"api.notes"`), or `"*"` (the default) for
   * every relation of the schemas that the `anon` or `authenticated` role holds a privilege on
   * AND that enforces row-level security: a table with RLS enabled, or a view created
   * `with (security_invoker = true)`. Tables with RLS off, ordinary (owner's-rights) views,
   * materialized views and foreign tables are skipped — one startup warning lists them — unless
   * named here: a list exposes exactly the named relations, whatever their RLS. A listed table
   * those roles cannot reach gets no route either. Functions are served when either role may
   * EXECUTE them.
   */
  tables?: string[] | "*";
  /** Where the routes live, app-relative (default `"/rest/v1"`). */
  basePath?: string;
  /** The most rows one read returns, whatever `limit` asks for (default 1000). */
  maxRows?: number;
  /** The largest request body accepted, in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Each request's `statement_timeout`, in milliseconds (default 5000). */
  statementTimeout?: number;
  /**
   * The most REST statements running at once, so the routes cannot take every connection of
   * the pool the rest of the app shares (default: half the pool's `max` when the client
   * reports it — `Deno.SQL` and postgres.js do — else 5). A request past it waits up to a
   * second, then is answered 503 `PGRST003` with `Retry-After`.
   */
  maxConcurrent?: number;
  /**
   * Who may ask for `Prefer: count=exact` on a read — a full count, as costly as reading every
   * matching row: `"authenticated"` (the default; an anonymous request is refused with 400),
   * `"all"`, or `"never"`. `count=planned` (the planner's estimate) is open to everyone.
   */
  exactCount?: "all" | "authenticated" | "never";
  /**
   * Answer `Accept: application/vnd.pgrst.plan` with the statement's execution plan (default
   * `false`: a 406). Plans reveal table sizes and indexes; turn this on in development only.
   */
  explain?: boolean;
  /**
   * Allow aggregate functions in `select=` (`amount.sum()`, `count()`, … grouped by the other
   * selected columns) — PostgREST's `db-aggregates-enabled` (default `false`: a 400). An
   * aggregate reads every matching row whatever `limit` says, so a caller could make the
   * database scan a whole table; turn it on when the tables are small or the statement timeout
   * bounds the cost.
   */
  aggregates?: boolean;
  /**
   * A request budget per client: a signed-in user by their user id, anyone else by their client
   * address (`clientIpForLimits()`'s rule — skipped for an untrusted loopback/private peer), the
   * secret key never. Past it a request is answered 429 `over_request_rate_limit` with
   * `Retry-After`, before any statement runs. Default `{ max: 1200, windowMs: 60_000 }` — 20
   * requests a second on average, far above what a page of supabase-js calls needs — counted per
   * process unless `store` is shared; `false` turns it off.
   */
  rateLimit?: RestRateLimitOptions | false;
  /**
   * Describe the routes in `@denext/openapi`'s document (default `true`): with that plugin
   * installed, `/openapi.json` (and its docs page, `denext openapi emit`, and the clients
   * generated from it) lists every relation and function of the default schema the `anon` and
   * `authenticated` roles can use — what the secret key alone reaches is left out — with typed
   * rows, PostgREST's filters and its error body. `false` keeps them out.
   */
  openapi?: boolean;
}

/** Validated auto-REST options. */
export interface ResolvedRest {
  /** The schemas, the default first. */
  schemas: string[];
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
  /** The concurrency cap, or `undefined` to derive it from the pool. */
  maxConcurrent: number | undefined;
  /** Who may count exactly. */
  exactCount: "all" | "authenticated" | "never";
  /** Whether execution plans are served. */
  explain: boolean;
  /** Whether aggregate functions are allowed. */
  aggregates: boolean;
  /** The request budget per client, or `null` (off). */
  rateLimit: ResolvedRestRateLimit | null;
  /** Whether the routes join `@denext/openapi`'s document. */
  openapi: boolean;
}

/** The schemas from `schema` / `schemas`, validated. */
function schemasOf(o: RestOptions): string[] {
  const schemas = o.schemas ?? [o.schema ?? "public"];
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new TypeError("backend(): rest.schemas must list at least one schema");
  }
  for (const schema of schemas) {
    if (typeof schema !== "string" || !IDENTIFIER.test(schema)) {
      throw new TypeError(
        `backend(): rest schema ${JSON.stringify(schema)} is not a plain identifier`,
      );
    }
  }
  return [...new Set(schemas)];
}

/**
 * Validate `backend({ rest })` and apply the defaults.
 *
 * @param o The options.
 * @returns The resolved options.
 * @throws {TypeError} For a bad schema, table list, base path or limit.
 */
export function resolveRest(o: RestOptions): ResolvedRest {
  const schemas = schemasOf(o);
  const tables = o.tables ?? "*";
  if (tables !== "*" && (!Array.isArray(tables) || tables.some((t) => typeof t !== "string"))) {
    throw new TypeError(`backend(): rest.tables must be "*" or a list of table names`);
  }
  const exactCount = o.exactCount ?? "authenticated";
  if (!["all", "authenticated", "never"].includes(exactCount)) {
    throw new TypeError(`backend(): rest.exactCount must be "all", "authenticated" or "never"`);
  }
  const basePath = (o.basePath ?? "/rest/v1").replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath === "") {
    throw new TypeError(`backend(): rest.basePath must be an absolute path such as "/rest/v1"`);
  }
  return {
    schemas,
    tables,
    basePath,
    maxRows: positiveOption(o.maxRows, 1000, "backend(): rest.maxRows"),
    maxBodyBytes: positiveOption(o.maxBodyBytes, 1024 * 1024, "backend(): rest.maxBodyBytes"),
    statementTimeout: positiveOption(o.statementTimeout, 5000, "backend(): rest.statementTimeout"),
    maxConcurrent: o.maxConcurrent === undefined
      ? undefined
      : positiveOption(o.maxConcurrent, 1, "backend(): rest.maxConcurrent"),
    exactCount,
    explain: o.explain === true,
    aggregates: o.aggregates === true,
    rateLimit: resolveRestRateLimit(o.rateLimit),
    openapi: o.openapi !== false,
  };
}

/** How long `denext dev` waits before re-reading the catalog for a name it does not know. */
const DEV_REFRESH_MS = 2000;

/**
 * Outside dev: how long after a read a name the catalog lacks re-reads it. A table a migration
 * created after boot (a rolling deploy, `denext migration up` against a live app) gets its route
 * without a restart, and a stream of requests for unknown names costs at most one catalog read
 * per interval.
 */
const PROD_REFRESH_MS = 10_000;

/**
 * The catalog, read once and shared; a failed read is retried by the next request. A request
 * for a table or function the catalog lacks re-reads it (at most every 2 s under `denext dev`,
 * every 10 s otherwise), so one created while the server runs gets its route; a
 * `NOTIFY pgrst, 'reload schema'` (PostgREST's signal, which `denext migration up` sends)
 * {@linkcode invalidate}s it, so a changed table is re-read too.
 */
export class RestCatalogCache {
  #pending: Promise<RestCatalog> | undefined;
  #readAt = 0;
  readonly #load: () => Promise<RestCatalog>;
  readonly #refreshMs: number;

  /**
   * A cache over `load`.
   *
   * @param load Reads the catalog.
   * @param dev `denext dev`: re-read on a miss after 2 s instead of 10 s.
   */
  constructor(load: () => Promise<RestCatalog>, dev: boolean) {
    this.#load = load;
    this.#refreshMs = dev ? DEV_REFRESH_MS : PROD_REFRESH_MS;
  }

  /** Drop the cached catalog: the next request reads it again (a schema-reload signal). */
  invalidate(): void {
    this.#pending = undefined;
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

  /**
   * Look something up, re-reading the catalog once on a miss (throttled).
   *
   * @param lookup Finds it in a catalog.
   * @returns What `lookup` found (in the re-read catalog after a miss), and that catalog.
   */
  async find<T>(
    lookup: (catalog: RestCatalog) => T | undefined,
  ): Promise<{ found: T | undefined; catalog: RestCatalog }> {
    let catalog = await this.get();
    let found = lookup(catalog);
    if (found === undefined && Date.now() - this.#readAt >= this.#refreshMs) {
      this.#pending = undefined;
      catalog = await this.get();
      found = lookup(catalog);
    }
    return { found, catalog };
  }

  /** One exposed table of `schema`, or `undefined`. */
  async table(schema: string, name: string): Promise<RestTable | undefined> {
    return (await this.find((c) => tableIn(c, schema, name))).found;
  }
}

/** The startup warning for the relations `tables: "*"` skipped, or `null` when none were. */
export function skippedWarning(skipped: SkippedRelation[]): string | null {
  if (!skipped.length) return null;
  const lines = skipped.map((s) => `  - ${s.schema}.${s.name} (${s.kind}): ${s.reason}`);
  return [
    `[@denext/backend] rest: ${skipped.length} relation(s) the anon / authenticated roles can ` +
    `reach get no route, because they do not enforce row-level security:`,
    ...lines,
    `  Enable RLS (alter table … enable row level security) or recreate a view with ` +
    `(security_invoker = true) to serve one; or name it in rest.tables to serve it as is.`,
  ].join("\n");
}

/** PostgREST's notification channel (`db-channel`), which `denext migration up` notifies too. */
const RELOAD_CHANNEL = "pgrst";

/**
 * Whether a `pgrst` notification asks for a schema reload: `reload schema`, or an empty payload
 * (PostgREST reloads the schema and the config on one).
 *
 * @param payload The notification's payload.
 * @returns Whether to re-read the catalog.
 */
export function isSchemaReload(payload: string): boolean {
  const p = payload.trim().toLowerCase();
  return p === "" || p === "reload schema";
}

/**
 * Re-read the catalog on `NOTIFY pgrst, 'reload schema'` — every replica listens, so one
 * migration run reaches them all — and after a reconnect (a notification sent while the
 * listener was down is lost). Without `listen()` (a client that can't LISTEN) the throttled
 * re-read on a miss still applies.
 */
function listenForSchemaReload(
  ctx: PluginContext,
  catalog: RestCatalogCache,
  sql: SqlClient | undefined,
): void {
  if (!sql?.listen) return;
  let first = true;
  const subscription = sql.listen(
    RELOAD_CHANNEL,
    (payload) => {
      if (isSchemaReload(payload)) catalog.invalidate();
    },
    () => {
      if (!first) catalog.invalidate();
      first = false;
    },
  );
  subscription.catch((error) =>
    console.warn(
      `[@denext/backend] rest: not listening for schema reloads (${
        (error as Error)?.message ?? error
      }); a new table still gets its route within 10 s`,
    )
  );
  ctx.addTeardown(async () => {
    await (await subscription.catch(() => undefined))?.unlisten();
  });
}

/**
 * The catalog loader the plugin uses: the RLS roles first (the privilege checks name them),
 * then the connecting role's view of `pg_catalog`. The relations `"*"` skipped are warned about
 * once per distinct list (a dev re-read that finds the same ones stays quiet).
 */
function catalogLoader(rest: ResolvedRest): () => Promise<RestCatalog> {
  let warned = "";
  const warn = (skipped: SkippedRelation[]) => {
    const message = skippedWarning(skipped);
    if (message && message !== warned) console.warn(message);
    warned = message ?? "";
  };
  return () =>
    rlsReady().then(() => readRestCatalog(db.service(), rest.schemas, rest.tables, warn));
}

/** How long a REST request waits for a free statement slot before it is turned away. */
const QUEUE_WAIT_MS = 1000;

/**
 * At most `max` REST statements at once; the next ones queue, each for up to
 * {@linkcode QUEUE_WAIT_MS}, then fail with 503 `PGRST003` — the pool the app shares keeps
 * connections for everything else.
 */
export class StatementGate {
  #active = 0;
  readonly #queue: Array<() => void> = [];
  readonly #max: number;
  readonly #waitMs: number;

  /**
   * A gate.
   *
   * @param max How many statements may run at once.
   * @param waitMs How long one may wait for a slot.
   */
  constructor(max: number, waitMs = QUEUE_WAIT_MS) {
    this.#max = max;
    this.#waitMs = waitMs;
  }

  /** Run `fn` in a slot. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active < this.#max) this.#active++;
    else await this.#wait();
    try {
      return await fn();
    } finally {
      // A waiter inherits the slot; otherwise it frees up.
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }

  #wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.#queue.indexOf(grant);
        if (at >= 0) this.#queue.splice(at, 1);
        reject(
          new RestError(
            503,
            "PGRST003",
            "too many requests are reading the database; try again shortly",
            null,
            "Retry after the number of seconds in the Retry-After header.",
          ),
        );
      }, this.#waitMs);
      this.#queue.push(grant);
    });
  }
}

/** The pool's `max`, when the client reports it (`Deno.SQL` and postgres.js: `options.max`). */
function poolMax(): number | undefined {
  try {
    const max = (db.service() as unknown as { options?: { max?: unknown } }).options?.max;
    return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The concurrency cap: `rest.maxConcurrent`, else half the pool (at least 1), else 5 — read on
 * first use, once the client is installed.
 */
export function concurrencyOf(rest: ResolvedRest, max = poolMax()): number {
  if (rest.maxConcurrent !== undefined) return rest.maxConcurrent;
  return max === undefined ? 5 : Math.max(1, Math.floor(max / 2));
}

// ── Identity ─────────────────────────────────────────────────────────────────
//
// Who a request is comes from the shared identity function (`resolveIdentity`, `identity.ts`):
// a user's access token (`Authorization: Bearer <jwt>`), the secret key (`service_role`, which
// bypasses row-level security), the denext session (cookie or native token), or `anon` — the
// same order supabase-js's `apikey` + `Authorization` headers are read in everywhere else in the
// backend. It is resolved once per request, up front, so a presented-but-refused credential is
// PostgREST's 401 before any statement; the statements themselves run through `db()`, which
// resolves the same identity (memoized per request) for `request.jwt.claims`.

/** The client a REST statement runs on: the request's identity under row-level security. */
function scopedDb(): SqlClient {
  return db();
}

/**
 * The request's identity, or PostgREST's 401 for a refused credential — after charging the
 * request to its client's budget (a refused one to its address), so a 429 comes first.
 */
async function identityOf(request: Request, limiter: RestLimiter | null): Promise<RequestIdentity> {
  try {
    const identity = await resolveIdentity(request);
    await limiter?.charge(identity);
    return identity;
  } catch (error) {
    if (!isIdentityError(error)) throw error;
    await limiter?.chargeRefused();
    const expired = error.code === "jwt_expired";
    throw new RestError(
      401,
      expired ? "PGRST303" : "PGRST301",
      error.message,
      null,
      expired ? "Refresh the session and retry with the new access token" : null,
    );
  }
}

// ── Running statements ───────────────────────────────────────────────────────

/** The `set_config`s that bound every statement after them in the transaction. */
const BOUND_SQL = "select set_config('statement_timeout', $1, true)";
/** The same, for a read: the transaction is READ ONLY too, as PostgREST's GETs are. */
const BOUND_READ_SQL = BOUND_SQL + ", set_config('transaction_read_only', 'on', true)";

/** Thrown inside a transaction to roll it back after its results were read. */
class Rollback {
  constructor(readonly value: unknown) {}
}

/** How a transaction runs. */
interface TxOptions {
  /** The statement timeout (ms). */
  timeout: number;
  /** READ ONLY. */
  readOnly: boolean;
  /** Roll back once the work is done (`tx=rollback`, an analyzed plan). */
  rollback: boolean;
}

/** Runs one statement inside the transaction, answering its rows. */
type Exec = (statement: RestStatement) => Promise<SqlRow[]>;

/**
 * Run `work` in one transaction through `scopedDb()` — as the request's user, or `anon` —
 * after bounding it with `statement_timeout` (and READ ONLY for a read). A throw from `work`
 * rolls the transaction back; so does `rollback`, after `work`'s answer was read.
 */
async function inTransaction<T>(options: TxOptions, work: (exec: Exec) => Promise<T>): Promise<T> {
  try {
    return await scopedDb().begin(async (tx) => {
      const bounded = start(
        tx.unsafe(options.readOnly ? BOUND_READ_SQL : BOUND_SQL, [String(options.timeout)]),
      );
      const exec: Exec = async (statement) => {
        const rows = await start(tx.unsafe(statement.text, statement.params));
        return [...rows];
      };
      const [, value] = await Promise.all([bounded, work(exec)]);
      if (options.rollback) throw new Rollback(value);
      return value;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
}

// ── Request parsing ──────────────────────────────────────────────────────────

/** The CSRF check a cookie-carrying write passes. */
const checkCsrf = csrf();

/**
 * Refuse a cross-site write that rides the page's cookies (the Server Actions rule). A native
 * app's bearer session is exempt — exactly when `auth()` reads the token instead of the cookie
 * (`nativeBearerToken` is its parser), so no header spelling earns the exemption while the
 * cookie still authenticates.
 */
async function guardWrite(request: Request, identity: RequestIdentity): Promise<void> {
  if (nativeBearerToken(request) !== undefined) return;
  // A Supabase access token or the secret key decided who this is: no cookie was used.
  if (identity.source === "jwt" || identity.role === "service_role") return;
  await checkCsrf({
    request,
    params: {},
    ctx: {},
    method: request.method as "POST",
  });
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

/** Refuse `count=exact` for a requester `exactCount` does not allow. */
function checkExactCount(rest: ResolvedRest, identity: RequestIdentity): void {
  if (rest.exactCount === "all") return;
  if (rest.exactCount === "authenticated" && identity.role !== "anon") return;
  throw new RestError(
    400,
    "PGRST100",
    rest.exactCount === "never"
      ? "Prefer: count=exact is not available on this API"
      : "Prefer: count=exact is only available to signed-in users",
    null,
    "Drop Prefer: count=exact and page with limit / offset (or Range) instead, or ask for " +
      'count=planned; the server can allow it with backend({ rest: { exactCount: "all" } }).',
  );
}

/** The body's shape for the response media. */
function shapeOf(media: Media, catalog: RestCatalog): BodyShape {
  if (media.kind === "geojson") {
    if (!catalog.postgis) {
      throw new RestError(
        406,
        "PGRST107",
        "None of these media types are available: application/geo+json",
        "GeoJSON needs the PostGIS extension in the database",
      );
    }
    return "geojson";
  }
  return (media.kind === "object" || media.kind === "array") && media.stripped
    ? "stripped"
    : "json";
}

/** Refuse a plan request unless `explain` is on. */
function checkExplain(rest: ResolvedRest, media: Media): void {
  if (media.kind === "plan" && !rest.explain) {
    throw new RestError(
      406,
      "PGRST107",
      "None of these media types are available: application/vnd.pgrst.plan",
      "Execution plans are off; enable them in development with backend({ rest: { explain: true } })",
    );
  }
}

/** `EXPLAIN (…) <statement>` for a plan request. */
function explained(statement: RestStatement, media: Media & { kind: "plan" }): RestStatement {
  const options = [
    `FORMAT ${media.format.toUpperCase()}`,
    ...media.options.map((o) => o.toUpperCase()),
  ];
  return { text: `EXPLAIN (${options.join(", ")}) ${statement.text}`, params: statement.params };
}

/** The planner's row estimate from an `EXPLAIN (FORMAT JSON)` row. */
function plannedRows(row: SqlRow | undefined): number {
  let plan = row?.["QUERY PLAN"];
  if (typeof plan === "string") plan = JSON.parse(plan);
  const rows = (plan as Array<{ Plan?: { "Plan Rows"?: unknown } }> | undefined)?.[0]?.Plan?.[
    "Plan Rows"
  ];
  return typeof rows === "number" ? rows : 0;
}

/** Common headers: never cached (the rows are this user's), what `Prefer` applied, the schema. */
function baseHeaders(prefs: Preferences, rest: ResolvedRest, schema: string): Headers {
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (prefs.applied.length) headers.set("preference-applied", prefs.applied.join(", "));
  if (rest.schemas.length > 1) headers.set("content-profile", schema);
  return headers;
}

/** The content type for the response media. */
function contentTypeOf(media: Media): string {
  switch (media.kind) {
    case "object":
      return "application/vnd.pgrst.object+json; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "geojson":
      return "application/geo+json; charset=utf-8";
    case "plan":
      return `application/vnd.pgrst.plan+${media.format}; for="${media.for}"; charset=utf-8`;
    default:
      return "application/json; charset=utf-8";
  }
}

/** The response body text for `body` (Postgres's JSON array text) in the response media. */
function bodyText(body: string, media: Media): string {
  if (media.kind === "object") return body.slice(1, -1).trim();
  if (media.kind === "csv") return csvFromJson(body);
  return body;
}

/** A plan's rows → the body text. */
function planText(row: SqlRow | undefined, rows: SqlRow[], media: Media & { kind: "plan" }) {
  if (media.format === "text") return rows.map((r) => String(r["QUERY PLAN"])).join("\n");
  const plan = row?.["QUERY PLAN"];
  return typeof plan === "string" ? plan : JSON.stringify(plan);
}

/** Run an explained statement (always rolled back) and answer its plan. */
async function planResponse(
  rest: ResolvedRest,
  gate: () => StatementGate,
  statement: RestStatement,
  media: Media & { kind: "plan" },
  readOnly: boolean,
): Promise<Response> {
  const rows = await gate().run(() =>
    inTransaction(
      { timeout: rest.statementTimeout, readOnly, rollback: true },
      (exec) => exec(explained(statement, media)),
    )
  );
  return new Response(planText(rows[0], rows, media), {
    status: 200,
    headers: { "content-type": contentTypeOf(media), "cache-control": "private, no-store" },
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Whether a select tree uses an aggregate anywhere. */
function usesAggregates(items: readonly SelectItem[]): boolean {
  return items.some((item) =>
    item.kind === "aggregate" || (item.kind === "embed" && usesAggregates(item.select))
  );
}

/** `select=`, refused when it aggregates and `rest.aggregates` is off. */
function selectOf(ctx: Ctx, raw: string | null = ctx.query.get("select")): SelectItem[] {
  const items = parseSelect(raw);
  if (!ctx.rest.aggregates && usesAggregates(items)) {
    throw new RestError(
      400,
      "PGRST123",
      "Use of aggregate functions is not allowed",
      null,
      "The server can allow them with backend({ rest: { aggregates: true } }).",
    );
  }
  return items;
}

/** Everything one handled request carries. */
interface Ctx {
  rest: ResolvedRest;
  gate: () => StatementGate;
  catalog: RestCatalog;
  request: Request;
  query: URLSearchParams;
  prefs: Preferences;
  media: Media;
  schema: string;
  identity: RequestIdentity;
}

/** The counting a read does: exact in its statement, or the planner's estimate beside it. */
function countingOf(ctx: Ctx): { exact: boolean; planned: boolean } {
  const count = ctx.prefs.count;
  if (count === "exact") checkExactCount(ctx.rest, ctx.identity);
  return { exact: count === "exact", planned: count === "planned" || count === "estimated" };
}

/**
 * Run a read-shaped statement (a select, or a function's rows) with its planned count, and
 * answer the rows: `estimated` counts exactly when the planner expects at most `maxRows` rows.
 */
async function readRows(
  ctx: Ctx,
  build: (count: boolean) => RestStatement,
  planned: (() => RestStatement) | undefined,
  readOnly: boolean,
): Promise<{ row: SqlRow | undefined; total: number | undefined }> {
  const tx = { timeout: ctx.rest.statementTimeout, readOnly, rollback: ctx.prefs.rollback };
  const object = ctx.media.kind === "object";
  return await ctx.gate().run(() =>
    inTransaction(tx, async (exec) => {
      let estimate: number | undefined;
      if (planned) estimate = plannedRows((await exec(planned()))[0]);
      const exact = ctx.prefs.count === "exact" ||
        (ctx.prefs.count === "estimated" && estimate !== undefined && estimate <= ctx.rest.maxRows);
      const [row] = await exec(build(exact));
      if (object) requireOne(Number(row?.n ?? 0));
      return { row, total: exact ? Number(row?.total ?? 0) : estimate };
    })
  );
}

/** Answer a page of rows. */
function rowsResponse(
  ctx: Ctx,
  row: SqlRow | undefined,
  total: number | undefined,
  offset: number,
): Response {
  const { contentRange, status } = rangeOutcome(offset, Number(row?.n ?? 0), total);
  const headers = baseHeaders(ctx.prefs, ctx.rest, ctx.schema);
  headers.set("content-range", contentRange);
  headers.set("content-type", contentTypeOf(ctx.media));
  const head = ctx.request.method === "HEAD";
  return new Response(head ? null : bodyText(String(row?.body ?? "[]"), ctx.media), {
    status,
    headers,
  });
}

/** Keep only the read preferences in `Preference-Applied`. */
function readApplied(prefs: Preferences): void {
  prefs.applied = prefs.applied.filter((p) =>
    p.startsWith("count=") || p.startsWith("tx=") || p.startsWith("handling=")
  );
}

/** GET / HEAD on a table or view. */
async function read(ctx: Ctx, table: RestTable): Promise<Response> {
  readApplied(ctx.prefs);
  const shape = shapeOf(ctx.media, ctx.catalog);
  const plan = planOf(ctx.catalog, tableSource(table), selectOf(ctx));
  applyQuery(plan, ctx.query);
  const { offset, limit } = pageOf(ctx.rest, ctx.request, ctx.query);
  const counting = countingOf(ctx);
  const build = (count: boolean) => buildSelect(plan, ctx.catalog, { offset, limit, count, shape });
  if (ctx.media.kind === "plan") {
    return await planResponse(ctx.rest, ctx.gate, build(false), ctx.media, true);
  }
  const planned = counting.planned ? () => buildPlannedCount(plan, ctx.catalog) : undefined;
  const { row, total } = await readRows(ctx, build, planned, true);
  return rowsResponse(ctx, row, total, offset);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** The items `return=headers-only` reads back: the primary key, to build `Location`. */
function primaryKeyItems(table: RestTable): SelectItem[] {
  return table.primaryKey.map((name) => ({
    kind: "field",
    field: { column: name, path: [] },
    key: name,
  }));
}

/** What a write answers with, from `Prefer` and the media. */
function writeReturnOf(ctx: Ctx, shape: BodyShape): WriteReturn {
  const ret = ctx.prefs.return;
  if (ret === "representation" || ret === "headers-only") return { kind: "representation", shape };
  const counted = ctx.prefs.count !== undefined || ctx.prefs.maxAffected !== undefined ||
    ctx.media.kind === "object";
  return { kind: counted ? "count" : "none" };
}

/** The plan a write's representation is shaped by (and whose top level holds the filters). */
function writePlan(ctx: Ctx, table: RestTable): PlanNode {
  const items = ctx.prefs.return === "headers-only" ? primaryKeyItems(table) : selectOf(ctx);
  const plan = planOf(ctx.catalog, tableSource(table), items);
  applyQuery(plan, ctx.query);
  if (ctx.request.method !== "POST" && (ctx.query.has("limit") || ctx.query.has("offset"))) {
    throw new RestError(
      400,
      "PGRST100",
      "limit and offset are not supported on PATCH or DELETE",
      null,
      "filter the rows to change instead (?id=in.(1,2,3))",
    );
  }
  return plan;
}

/** `columns=`, when given. */
function columnsParam(query: URLSearchParams): string[] | undefined {
  const raw = query.get("columns");
  return raw === null ? undefined : parseNameList(raw, "columns");
}

/** The statement for a write: a DELETE, or an INSERT / UPSERT / UPDATE from the body. */
async function writeStatement(
  ctx: Ctx,
  table: RestTable,
  plan: PlanNode,
  returning: WriteReturn,
): Promise<RestStatement> {
  if (ctx.request.method === "DELETE") return buildDelete(table, plan, ctx.catalog, { returning });
  const body = await bodyOf(ctx.request, ctx.rest.maxBodyBytes);
  if (ctx.request.method === "PUT") return buildPut(table, plan, ctx.catalog, body, { returning });
  const columns = columnsParam(ctx.query);
  if (ctx.request.method === "PATCH") {
    return buildUpdate(table, plan, ctx.catalog, body, {
      returning,
      ...(columns ? { columns } : {}),
    });
  }
  const onConflict = ctx.query.get("on_conflict");
  const resolution = ctx.prefs.resolution;
  return buildInsert(table, plan, ctx.catalog, body, {
    returning,
    missingDefault: ctx.prefs.missingDefault,
    ...(columns ? { columns } : {}),
    ...(resolution
      ? {
        conflict: {
          action: resolution,
          ...(onConflict === null ? {} : { columns: parseNameList(onConflict, "on_conflict") }),
        },
      }
      : {}),
  });
}

/** Refuse a write that touched more rows than `max-affected` allows (`handling=strict`). */
function checkAffected(prefs: Preferences, n: number): void {
  if (prefs.strict && prefs.maxAffected !== undefined && n > prefs.maxAffected) {
    throw new RestError(
      400,
      "PGRST124",
      "Query result exceeds max-affected preference constraint",
      `The query affects ${n} rows`,
    );
  }
}

/** `Location: /table?pk=eq.v` for the first written row (`return=headers-only`). */
function locationOf(table: RestTable, body: string): string | undefined {
  const [first] = JSON.parse(body) as Record<string, unknown>[];
  if (!first || !table.primaryKey.length) return undefined;
  const query = new URLSearchParams();
  for (const key of table.primaryKey) query.set(key, `eq.${first[key]}`);
  return `/${encodeURIComponent(table.name)}?${query}`;
}

/** The response to a write that ran. */
function writeResponse(ctx: Ctx, table: RestTable, row: SqlRow | undefined): Response {
  const headers = baseHeaders(ctx.prefs, ctx.rest, ctx.schema);
  const created = ctx.request.method === "POST";
  // A PUT answers like a PATCH: 200 with the row, or 204.
  const n = Number(row?.n ?? 0);
  if (ctx.prefs.count !== undefined) headers.set("content-range", `*/${n}`);
  if (ctx.prefs.return === "headers-only") {
    const location = locationOf(table, String(row?.body ?? "[]"));
    if (location) headers.set("location", location);
    return new Response(null, { status: created ? 201 : 204, headers });
  }
  if (ctx.prefs.return !== "representation") {
    return new Response(null, { status: created ? 201 : 204, headers });
  }
  headers.set("content-type", contentTypeOf(ctx.media));
  return new Response(bodyText(String(row?.body ?? "[]"), ctx.media), {
    status: created ? 201 : 200,
    headers,
  });
}

/** Keep only the preferences a write honoured in `Preference-Applied`. */
function writeApplied(ctx: Ctx, returning: WriteReturn): void {
  ctx.prefs.applied = ctx.prefs.applied.filter((p) => {
    if (p.startsWith("count=")) return returning.kind !== "none";
    if (p.startsWith("resolution=") || p.startsWith("missing=")) {
      return ctx.request.method === "POST";
    }
    return !p.startsWith("params=");
  });
}

/** POST / PATCH / DELETE on a table or view. */
async function write(ctx: Ctx, table: RestTable): Promise<Response> {
  await guardWrite(ctx.request, ctx.identity);
  const shape = shapeOf(ctx.media, ctx.catalog);
  const plan = writePlan(ctx, table);
  const returning = writeReturnOf(ctx, shape);
  writeApplied(ctx, returning);
  const statement = await writeStatement(ctx, table, plan, returning);
  if (ctx.media.kind === "plan") {
    return await planResponse(ctx.rest, ctx.gate, statement, ctx.media, false);
  }
  const object = ctx.media.kind === "object";
  const tx = { timeout: ctx.rest.statementTimeout, readOnly: false, rollback: ctx.prefs.rollback };
  const row = await ctx.gate().run(() =>
    inTransaction(tx, async (exec) => {
      const [row] = await exec(statement);
      const n = Number(row?.n ?? 0);
      if (object) requireOne(n);
      checkAffected(ctx.prefs, n);
      return row;
    })
  );
  return writeResponse(ctx, table, row);
}

// ── Functions ────────────────────────────────────────────────────────────────

/** The arguments of a call: the query (GET / HEAD) or the body (POST). */
async function rpcInput(ctx: Ctx): Promise<RpcInput> {
  if (ctx.request.method !== "POST") return { kind: "query", query: ctx.query };
  await guardWrite(ctx.request, ctx.identity);
  const body = ctx.request.body === null && !ctx.request.headers.has("content-length")
    ? {}
    : await bodyOf(ctx.request, ctx.rest.maxBodyBytes);
  return { kind: "body", body: body === undefined ? {} : body };
}

/** The plan over a function's result. */
function rpcPlan(ctx: Ctx, fn: RestFunction, input: RpcInput): PlanNode {
  const composite = fn.returns.kind === "composite";
  const select = ctx.query.get("select");
  if (!composite && select !== null && select.trim() !== "" && select.trim() !== "*") {
    throw new RestError(400, "PGRST100", `${fn.name} returns no columns to select`);
  }
  const plan = planOf(ctx.catalog, functionSource(fn), composite ? selectOf(ctx, select) : []);
  const skip = input.kind === "query" ? new Set(fn.args.map((a) => a.name)) : new Set<string>();
  applyQuery(plan, ctx.query, skip);
  return plan;
}

/** Answer a call's result. */
function rpcResponse(
  ctx: Ctx,
  fn: RestFunction,
  row: SqlRow | undefined,
  total?: number,
  offset = 0,
) {
  const headers = baseHeaders(ctx.prefs, ctx.rest, ctx.schema);
  if (fn.returns.kind === "void") return new Response(null, { status: 204, headers });
  const head = ctx.request.method === "HEAD";
  if (fn.setOf) return rowsResponse(ctx, row, total, offset);
  headers.set(
    "content-type",
    contentTypeOf(ctx.media.kind === "csv" ? ctx.media : { kind: "json" }),
  );
  let body = String(row?.body ?? "null");
  if (fn.returns.kind === "composite") {
    body = Number(row?.n ?? 0) ? body.slice(1, -1).trim() : "null";
  }
  if (ctx.media.kind === "csv") body = csvFromJson(`[${body}]`);
  return new Response(head ? null : body, { status: 200, headers });
}

/** GET / HEAD / POST on `/rpc/<function>`. */
async function rpc(ctx: Ctx, name: string): Promise<Response> {
  readApplied(ctx.prefs);
  const input = await rpcInput(ctx);
  const catalog = ctx.catalog;
  const { fn, whole } = resolveFunction(catalog, ctx.schema, name, input, ctx.prefs.singleObject);
  if (ctx.prefs.singleObject) ctx.prefs.applied.push("params=single-object");
  const shape = shapeOf(ctx.media, catalog);
  const plan = rpcPlan(ctx, fn, input);
  const { offset, limit } = pageOf(ctx.rest, ctx.request, ctx.query);
  const counting = fn.setOf ? countingOf(ctx) : { exact: false, planned: false };
  if (!fn.setOf) delete ctx.prefs.count;
  const options = { fn, whole, input, offset, limit, shape };
  const build = (count: boolean) => buildRpc(plan, catalog, { ...options, count });
  const readOnly = ctx.request.method !== "POST";
  if (ctx.media.kind === "plan") {
    return await planResponse(ctx.rest, ctx.gate, build(false), ctx.media, readOnly);
  }
  const planned = counting.planned
    ? () => buildRpcPlannedCount(plan, catalog, { fn, whole, input })
    : undefined;
  if (!fn.setOf && ctx.media.kind === "object") ctx.media = { kind: "json" };
  const { row, total } = await readRows(ctx, build, planned, readOnly);
  return rpcResponse(ctx, fn, row, total, offset);
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** The methods each kind of route takes. */
const READS = new Set(["GET", "HEAD"]);
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Decode a path segment (`""` for a malformed escape or a slash inside it). */
function segmentName(segment: string): string {
  try {
    const name = decodeURIComponent(segment);
    return name.includes("/") ? "" : name;
  } catch {
    return "";
  }
}

/** The exposed table a path names, or a 404. */
async function tableOf(
  catalog: RestCatalogCache,
  schema: string,
  name: string,
  audience: (c: RestCatalog) => RestCatalog,
): Promise<{ table: RestTable; catalog: RestCatalog }> {
  const { found, catalog: whole } = await catalog.find((c) =>
    name === "" ? undefined : tableIn(audience(c), schema, name)
  );
  const current = audience(whole);
  if (!found) {
    throw new RestError(
      404,
      "PGRST205",
      `Could not find the table '${schema}.${name.slice(0, 64)}' in the schema cache`,
    );
  }
  return { table: found, catalog: current };
}

/** `GET /rest/v1/`: the OpenAPI description of what the requester can use. */
async function openApi(
  rest: ResolvedRest,
  cache: RestCatalogCache,
  request: Request,
  schema: string,
  audience: (c: RestCatalog) => RestCatalog,
): Promise<Response> {
  if (!READS.has(request.method)) {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const doc = openApiDocument(audience(await cache.get()), schema, url, rest.basePath);
  return new Response(request.method === "HEAD" ? null : JSON.stringify(doc), {
    status: 200,
    headers: {
      "content-type": "application/openapi+json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

/** Handle one request under the prefix. */
async function handle(
  rest: ResolvedRest,
  cache: RestCatalogCache,
  gate: () => StatementGate,
  limiter: RestLimiter | null,
  request: Request,
  path: string,
  query: URLSearchParams,
): Promise<Response> {
  const isRead = READS.has(request.method);
  if (!isRead && !WRITES.has(request.method)) {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD, POST, PUT, PATCH, DELETE" },
    });
  }
  const schema = profileOf(request, rest.schemas, !isRead);
  const identity = await identityOf(request, limiter);
  // The secret key sees every relation and function of the schemas (still only by catalog name).
  const audience = (c: RestCatalog) => identity.role === "service_role" ? c.service ?? c : c;
  if (path === "") return await openApi(rest, cache, request, schema, audience);
  const prefs = preferencesOf(request);
  const media = mediaOfRequest(request);
  checkExplain(rest, media);
  const base = { rest, gate, request, query, prefs, media, schema, identity };
  if (path.startsWith("rpc/")) {
    if (request.method !== "POST" && !isRead) {
      throw new RestError(405, "PGRST101", "For functions, only GET and POST verbs are allowed");
    }
    const name = segmentName(path.slice(4));
    const { catalog } = await cache.find((c) => audience(c).functions.get(schema)?.get(name));
    return await rpc({ ...base, catalog: audience(catalog) }, name);
  }
  const { table, catalog } = await tableOf(cache, schema, segmentName(path), audience);
  const ctx = { ...base, catalog };
  return isRead ? await read(ctx, table) : await write(ctx, table);
}

/**
 * The auto-REST request handler. Answers only paths under `rest.basePath`; everything else
 * passes (`null`).
 */
function restHandler(
  rest: ResolvedRest,
  cache: RestCatalogCache,
): (request: Request) => Promise<Response | null> {
  const prefix = `${rest.basePath}/`;
  let made: StatementGate | undefined;
  const gate = () => made ??= new StatementGate(concurrencyOf(rest));
  const limiter = rest.rateLimit ? new RestLimiter(rest.rateLimit) : null;
  return async (request) => {
    const url = new URL(request.url);
    const root = url.pathname === rest.basePath;
    if (!root && !url.pathname.startsWith(prefix)) return null;
    try {
      return await handle(
        rest,
        cache,
        gate,
        limiter,
        request,
        root ? "" : url.pathname.slice(prefix.length),
        url.searchParams,
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** The global slot `@denext/openapi` reads its sources from (no dependency on that package). */
const OPENAPI_SOURCES = Symbol.for("denext.openapi.sources");

/** The source's name in that registry. */
const OPENAPI_SOURCE_NAME = "@denext/backend rest";

/**
 * Register the auto-REST routes as a source of `@denext/openapi`'s document: the default schema
 * of the catalog the RLS roles see, under the app's `basePath` + `rest.basePath`.
 *
 * @param rest The resolved options.
 * @param read Reads the (cached) catalog.
 * @returns The teardown that unregisters it.
 */
export function registerOpenApi(rest: ResolvedRest, read: () => Promise<RestCatalog>): () => void {
  const slot = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
  const sources = slot[OPENAPI_SOURCES] ??= new Map();
  const source = {
    name: OPENAPI_SOURCE_NAME,
    describe: async ({ basePath }: { basePath: string }) =>
      openApiContribution(await read(), rest.schemas[0], basePath + rest.basePath),
  };
  sources.set(OPENAPI_SOURCE_NAME, source);
  return () => {
    if (sources.get(OPENAPI_SOURCE_NAME) === source) sources.delete(OPENAPI_SOURCE_NAME);
  };
}

/**
 * Wire auto-REST into the plugin: the request handler, the catalog read at startup (`dev`,
 * `prod`; a failure is retried by the first request), and the prepare step that writes the
 * types to `.denext/rest.ts`.
 *
 * @param ctx The plugin context.
 * @param rest The resolved options.
 */
export function setupRest(ctx: PluginContext, rest: ResolvedRest, sql?: SqlClient): void {
  const catalog = new RestCatalogCache(catalogLoader(rest), ctx.mode === "dev");
  ctx.addRequestHandler(restHandler(rest, catalog));
  if (rest.openapi) ctx.addTeardown(registerOpenApi(rest, () => catalog.get()));
  ctx.addPrepareStep(({ outDir }) => writeRestTypes(outDir, rest, () => catalog.get()));
  if (ctx.mode === "dev" || ctx.mode === "prod") {
    listenForSchemaReload(ctx, catalog, sql);
    catalog.get().catch((error) => {
      console.warn(
        `[@denext/backend] rest: could not read the catalog yet (retried on the first request): ${
          (error as Error)?.message ?? error
        }`,
      );
    });
  }
}
