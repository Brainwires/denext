/**
 * The Postgres client seam every denext Postgres feature drives (the auth adapter, the
 * migration runner, the cache, session and rate-limit stores): a {@linkcode SqlClient} is
 * anything with a tagged-template query, `unsafe(text, params)`, `begin(fn)` and `close()`.
 *
 * denext's Deno runtime has a built-in Postgres client, `Deno.SQL`, which already is one, so
 * {@linkcode postgresClient} hands it out with no dependency at all. Stock Deno has none:
 * there, bring a driver and adapt it — {@linkcode fromPostgresJs} wraps the npm `postgres`
 * package (denext does not depend on it; your app does):
 *
 * ```ts
 * // deno.json imports: "postgres": "npm:postgres@^3"
 * import postgres from "postgres";
 * import { fromPostgresJs, postgresAuthAdapter } from "denext/server";
 * const sql = fromPostgresJs(postgres(Deno.env.get("DATABASE_URL")!));
 * denextAuth({ ..., adapter: postgresAuthAdapter({ sql }) });
 * ```
 *
 * Every query denext itself sends goes through `unsafe(text, params)` with `$n` parameters —
 * values are always bound, never spliced into the text.
 *
 * @module
 */

/** One row, keyed by column name. */
export type SqlRow = Record<string, unknown>;

/** A query that may also run as a simple-protocol query (several statements, no parameters). */
export interface SqlQuery<T = SqlRow> extends PromiseLike<T[]> {
  /** Run it with the simple query protocol — how a multi-statement script is sent. */
  simple?(): PromiseLike<T[]>;
}

/**
 * The minimal Postgres client denext needs. `Deno.SQL` (denext's runtime) satisfies it as is;
 * on stock Deno, {@linkcode fromPostgresJs} adapts the npm `postgres` package.
 */
export interface SqlClient {
  /** A parameterized query: every interpolated value is bound as a parameter. */
  <T = SqlRow>(strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<T[]>;
  /**
   * A query from raw text with `$1`… parameters. The text is not escaped: never build it from
   * untrusted input.
   */
  unsafe<T = SqlRow>(text: string, params?: unknown[]): SqlQuery<T>;
  /**
   * Run `fn` in a transaction: COMMIT when it settles, ROLLBACK (and rethrow) when it throws.
   * An array `fn` returns is awaited as a whole (`Promise.all`), as `Deno.SQL` and postgres.js
   * do: `begin(tx => [tx\`…\`, tx\`…\`])` lets the driver pipeline the statements and COMMIT.
   */
  begin<T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T>;
  /**
   * Inside a transaction: run `fn` in a savepoint — RELEASE when it settles, ROLLBACK TO (and
   * rethrow) when it throws. Optional: `Deno.SQL` and {@linkcode fromPostgresJs} have it; a
   * nested transaction needs it.
   */
  savepoint?<T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T>;
  /**
   * Subscribe `fn` to a Postgres NOTIFY channel (`LISTEN`) on a connection of the client's own,
   * re-listening after a lost connection; `onlisten` runs once subscribed and again after each
   * reconnect (notifications sent while it was down are lost). Optional: `Deno.SQL` and
   * {@linkcode fromPostgresJs} have it; realtime features need it.
   */
  listen?(
    channel: string,
    fn: (payload: string) => void,
    onlisten?: () => void,
  ): Promise<SqlListener>;
  /**
   * A connection of the pool for this caller alone, until `release()` returns it — what holds a
   * session-level lock. Optional: `Deno.SQL` and {@linkcode fromPostgresJs} have it.
   */
  reserve?(): Promise<SqlClient & { release(): void | Promise<void> }>;
  /** Close the client's connections. */
  close(options?: { timeout?: number }): Promise<void>;
}

/** A subscription made with {@linkcode SqlClient.listen}. */
export interface SqlListener {
  /** Stop delivering to this callback (`UNLISTEN` once the channel has no callback left). */
  unlisten(): Promise<void>;
}

/** The `code` a Postgres feature's error carries when no client is available. */
export const POSTGRES_UNSUPPORTED = "unsupported";

/** Why a Postgres feature could not run: no `Deno.SQL` and no client was passed. */
export class PostgresUnsupportedError extends Error {
  /** Always {@linkcode POSTGRES_UNSUPPORTED}. */
  readonly code: typeof POSTGRES_UNSUPPORTED = POSTGRES_UNSUPPORTED;

  /**
   * Build the error.
   *
   * @param feature What needed Postgres (`"postgresAuthAdapter"`).
   */
  constructor(feature: string) {
    super(
      `${feature}: this Deno has no built-in Postgres client (Deno.SQL, part of denext's Deno ` +
        "runtime). On stock Deno pass a client instead: `sql: fromPostgresJs(postgres(url))` " +
        "with the npm `postgres` package (see https://denext.dev/docs/database#postgres).",
    );
    this.name = "PostgresUnsupportedError";
  }
}

/** The `Deno.SQL` constructor, when this runtime has one. */
type DenoSqlConstructor = new (url?: string) => SqlClient;

/**
 * The runtime's built-in `Deno.SQL` constructor, or `undefined` on a Deno without one.
 *
 * @returns The constructor.
 */
export function builtinSql(): DenoSqlConstructor | undefined {
  const ctor = (Deno as unknown as { SQL?: unknown }).SQL;
  return typeof ctor === "function" ? ctor as DenoSqlConstructor : undefined;
}

/** Whether a URL names a Postgres database (`postgres://` / `postgresql://`). */
export function isPostgresUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^postgres(?:ql)?:\/\//i.test(url.trim());
}

/**
 * A Postgres client on the runtime's built-in `Deno.SQL` — the zero-dependency path.
 *
 * @param url A `postgres://` connection string; without one, `Deno.SQL`'s own defaults
 *   (`POSTGRES_URL` / `DATABASE_URL` / `PG*`).
 * @param feature The caller, named in the error when there is no `Deno.SQL`.
 * @returns The client (nothing connects until the first query).
 * @throws {PostgresUnsupportedError} On a Deno without `Deno.SQL`.
 */
export function postgresClient(url?: string, feature = "postgresClient"): SqlClient {
  const SQL = builtinSql();
  if (!SQL) throw new PostgresUnsupportedError(feature);
  return url === undefined ? new SQL() : new SQL(url);
}

/** The shape of an npm `postgres` (postgres.js) client that {@linkcode fromPostgresJs} reads. */
export interface PostgresJsLike {
  /** The tagged-template query. */
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
  /** A raw-text query with parameters. */
  unsafe(text: string, params?: unknown[]): PromiseLike<unknown> & {
    simple?(): PromiseLike<unknown>;
  };
  /** A transaction (postgres.js passes the transaction's own client). */
  begin(fn: (tx: PostgresJsLike) => unknown): Promise<unknown>;
  /** A savepoint (on a transaction's client). */
  savepoint?(fn: (tx: PostgresJsLike) => unknown): Promise<unknown>;
  /** LISTEN on a channel (on the pool's client). */
  listen?(
    channel: string,
    fn: (payload: string) => void,
    onlisten?: () => void,
  ): Promise<{ unlisten(): Promise<unknown> }>;
  /** A reserved connection (on the pool's client). */
  reserve?(): Promise<PostgresJsLike & { release(): void }>;
  /** Close the pool (absent on a transaction's client). */
  end?(options?: { timeout?: number }): Promise<void>;
}

/**
 * Adapt an npm `postgres` (postgres.js) client to a {@linkcode SqlClient} — the stock-Deno path
 * for every denext Postgres feature. denext does not depend on the package: import it in your
 * app (`npm:postgres`) and pass the wrapped client as `sql`.
 *
 * @param pg The postgres.js client (`postgres(url)`).
 * @returns The client; `close()` ends the pool (a no-op on a transaction's client).
 */
export function fromPostgresJs(pg: PostgresJsLike): SqlClient {
  const client =
    ((strings: TemplateStringsArray, ...values: unknown[]) => pg(strings, ...values)) as SqlClient;
  client.unsafe = <T>(text: string, params?: unknown[]) =>
    pg.unsafe(text, params) as unknown as SqlQuery<T>;
  client.begin = <T>(fn: (tx: SqlClient) => T | Promise<T>) =>
    pg.begin((tx) => fn(fromPostgresJs(tx))) as Promise<T>;
  if (pg.savepoint) {
    const savepoint = pg.savepoint.bind(pg);
    client.savepoint = <T>(fn: (tx: SqlClient) => T | Promise<T>) =>
      savepoint((tx) => fn(fromPostgresJs(tx))) as Promise<T>;
  }
  if (pg.listen) {
    const listen = pg.listen.bind(pg);
    client.listen = async (channel, fn, onlisten) => {
      const listener = await listen(channel, fn, onlisten);
      return {
        async unlisten() {
          await listener.unlisten();
        },
      };
    };
  }
  if (pg.reserve) {
    const reserve = pg.reserve.bind(pg);
    client.reserve = async () => {
      const reserved = await reserve();
      return Object.assign(fromPostgresJs(reserved), {
        release: () => reserved.release(),
        // Closing a reserved handle returns it; the pool stays the caller's.
        close: () => Promise.resolve(reserved.release()),
      });
    };
  }
  client.close = async (options) => {
    await pg.end?.(options);
  };
  return client;
}

/** A Postgres error's SQLSTATE (`"23505"`), when it carries one. */
export function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Run a multi-statement script: the simple protocol when the client offers it. */
export function runScript(sql: SqlClient, text: string): PromiseLike<unknown> {
  const query = sql.unsafe(text);
  return query.simple ? query.simple() : query;
}

/** A plain identifier (a schema or table name denext will quote), refused otherwise. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * The prefix that qualifies a table with `schema` (`"app".`), or `""` for the search path.
 *
 * @param schema The schema, if any.
 * @param feature The caller, named in the error.
 * @returns The prefix.
 * @throws {TypeError} For a schema that is not a plain identifier.
 */
export function schemaPrefix(schema: string | undefined, feature: string): string {
  if (schema === undefined) return "";
  if (!IDENTIFIER.test(schema)) {
    throw new TypeError(
      `${feature}: ${JSON.stringify(schema)} is not a plain identifier ` +
        "(letters, digits and underscores, not starting with a digit)",
    );
  }
  return `"${schema}".`;
}

/** A column value as a number (`int8` / `numeric` arrive as strings), else `undefined`. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Options shared by every denext Postgres store: a client, or a URL to open one. */
export interface PostgresConnectionOptions {
  /** A client to use (yours stays open: denext never closes a client it was handed). */
  sql?: SqlClient;
  /** A `postgres://` URL, opened with `Deno.SQL` (denext's runtime) and closed on `close()`. */
  url?: string;
  /** A schema to keep the tables in (created when missing); default: the search path. */
  schema?: string;
}

/** A resolved connection: the client, and whether closing the store closes it. */
export interface ResolvedConnection {
  /** The client. */
  sql: SqlClient;
  /** True when denext opened it (from `url`) and so must close it. */
  owned: boolean;
}

/**
 * Resolve `{ sql | url }` to a client.
 *
 * @param options The store's options.
 * @param feature The store, named in errors.
 * @returns The client and its ownership.
 * @throws {TypeError} When neither (or both) is given.
 * @throws {PostgresUnsupportedError} For a `url` on a Deno without `Deno.SQL`.
 */
export function resolveConnection(
  options: PostgresConnectionOptions,
  feature: string,
): ResolvedConnection {
  if (options.sql && options.url) {
    throw new TypeError(`${feature}: pass either \`sql\` or \`url\`, not both`);
  }
  if (options.sql) return { sql: options.sql, owned: false };
  if (!options.url) {
    throw new TypeError(`${feature}: pass \`sql\` (a client) or \`url\` (a postgres:// URL)`);
  }
  return { sql: postgresClient(options.url, feature), owned: true };
}
