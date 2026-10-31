/**
 * A Prisma driver adapter for Postgres and SQLite over the runtime's built-in `Deno.SQL`: Prisma
 * ORM with no npm database driver (no `pg`, no `better-sqlite3`), so the app's runtime database
 * path is zero-npm apart from Prisma's own client.
 *
 * ```ts
 * import { PrismaClient } from "./generated/client/client.ts";
 * import { PrismaDenoSql } from "denext/prisma-adapter";
 *
 * const prisma = new PrismaClient({ adapter: new PrismaDenoSql(Deno.env.get("DATABASE_URL")!) });
 * ```
 *
 * The URL picks the database: `postgres://` / `postgresql://` for Postgres, `file:` (relative to
 * the working directory), `sqlite:` or `:memory:` for SQLite. Prisma's own Postgres URL
 * parameters are read, not sent to the server: `schema` (the `search_path`),
 * `connection_limit` (the pool size), `connect_timeout` / `pool_timeout` (seconds) and
 * `pgbouncer=true` (no prepared statements).
 *
 * Use it with Prisma 7's `prisma-client` generator (`runtime = "deno"`); `denext migrate` wires
 * all of it.
 *
 * Needs denext's Deno runtime 3.0.0-rc.1 or later: the adapter reads each result column's
 * type from `Deno.SQL`'s `result.columns`, which earlier runtimes do not report
 * ({@linkcode denoSqlHasColumns} tells).
 *
 * @module
 */

import {
  type DenoSqlClient,
  denoSqlConstructor,
  denoSqlHasColumns,
  type DenoSqlOptions,
  type SqlColumn,
  type SqlRequest,
  type SqlRows,
} from "./client.ts";
import {
  ADAPTER_NAME,
  DenoSqlAdapter,
  type Driver,
  postgresDriver,
  sqliteDriver,
} from "./adapter.ts";
import type { TimestampFormat } from "./sqlite.ts";
import type { SqlDriverAdapter, SqlMigrationAwareDriverAdapterFactory } from "./types.ts";

export { denoSqlHasColumns };
export type { DenoSqlClient, DenoSqlOptions, SqlColumn, SqlRequest, SqlRows, TimestampFormat };
export {
  type AdapterError,
  type ArgScalarType,
  type ArgType,
  type ColumnType,
  ColumnTypeEnum,
  type ConnectionInfo,
  DriverAdapterError,
  type ErrorConstraint,
  type IsolationLevel,
  type MappedError,
  type Provider,
  type SqlDriverAdapter,
  type SqlMigrationAwareDriverAdapterFactory,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
  type Transaction,
} from "./types.ts";

/** Options of {@linkcode PrismaDenoSql}. */
export interface PrismaDenoSqlOptions {
  /** The database, when a passed client (or an unusual URL) does not tell. */
  provider?: "postgres" | "sqlite";
  /** Postgres: the schema queries run in (the `search_path`), unless the URL's `schema` names one. */
  schema?: string;
  /** SQLite: how `DateTime` arguments are stored (default ISO 8601 text, as Prisma does). */
  timestampFormat?: TimestampFormat;
  /** The database `prisma migrate` diffs against (SQLite: default `:memory:`). */
  shadowDatabaseUrl?: string;
  /** A passed client: close it on `dispose()` (default: leave it open). */
  disposeClient?: boolean;
  /** Further `Deno.SQL` options for a client the adapter opens (`tls`, `max`, …). */
  sql?: DenoSqlOptions;
}

/** The database a connection URL names. */
function providerOf(url: string): "postgres" | "sqlite" | null {
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (/^(file:|sqlite:|:memory:)/i.test(url)) return "sqlite";
  return null;
}

/**
 * The database a URL or a passed client is for (a client says `sqlite` in its options, else
 * it is Postgres, `Deno.SQL`'s default).
 *
 * @throws {TypeError} For a URL that names neither.
 */
function targetProvider(url: string | null, client: DenoSqlClient | null): "postgres" | "sqlite" {
  if (client) return client.options?.adapter === "sqlite" ? "sqlite" : "postgres";
  const provider = providerOf(url!);
  if (!provider) {
    throw new TypeError(
      `denext/prisma-adapter: cannot tell the database from "${url}" — pass { provider }.`,
    );
  }
  return provider;
}

/** Prisma-only URL parameters a Postgres server would refuse as run-time parameters. */
const PRISMA_ONLY_PARAMS = [
  "socket_timeout",
  "statement_cache_size",
  "sslaccept",
  "sslidentity",
  "sslpassword",
  "max_connection_lifetime",
  "max_idle_connection_lifetime",
];

/**
 * A Postgres URL with Prisma's own parameters read into `Deno.SQL` options and removed, as
 * {@linkcode PrismaDenoSql} does before it connects. `schema` becomes the `search_path`,
 * `connection_limit` the pool's `max`, `connect_timeout` (or `pool_timeout`) the
 * `connectionTimeout`, and `pgbouncer=true` turns prepared statements off; Prisma-only
 * parameters a server would refuse (`socket_timeout`, `statement_cache_size`, `sslaccept`, …)
 * are dropped. Use it to open a `Deno.SQL` client of your own from a Prisma `DATABASE_URL`.
 *
 * ```ts
 * const { url, options } = postgresConnection(Deno.env.get("DATABASE_URL")!, undefined);
 * const adapter = new PrismaDenoSql(new Deno.SQL(url, { ...options, max: 20 }));
 * ```
 *
 * @param url A `postgres://` / `postgresql://` URL, Prisma's parameters included.
 * @param schemaOption The schema to use when the URL names none (the adapter's `schema` option).
 * @returns The URL without Prisma's parameters, the `Deno.SQL` options read from them, and the
 *   schema in effect.
 */
export function postgresConnection(
  url: string,
  schemaOption: string | undefined,
): { url: string; options: DenoSqlOptions; schema: string | undefined } {
  const u = new URL(url);
  const take = (key: string) => {
    const value = u.searchParams.get(key);
    u.searchParams.delete(key);
    return value ?? undefined;
  };
  const schema = take("schema") ?? schemaOption;
  const limit = take("connection_limit");
  const timeout = take("connect_timeout") ?? take("pool_timeout");
  take("pool_timeout");
  const pgbouncer = take("pgbouncer");
  for (const key of PRISMA_ONLY_PARAMS) u.searchParams.delete(key);
  const options: DenoSqlOptions = { adapter: "postgres" };
  if (schema) options.connection = { search_path: `"${schema.replaceAll('"', '""')}"` };
  if (limit) options.max = Number(limit);
  if (timeout) options.connectionTimeout = Number(timeout);
  if (pgbouncer === "true") options.prepare = false;
  return { url: u.href, options, schema };
}

/** Open a `Deno.SQL` client, or explain why there is none. */
function openClient(url: string, options: DenoSqlOptions): DenoSqlClient {
  const SQL = denoSqlConstructor();
  if (!SQL) {
    throw new Error(
      "denext/prisma-adapter: this Deno has no Deno.SQL — run the app on denext's Deno runtime " +
        "(3.0.0-rc.1 or later; `denext dev` / `denext start` use it).",
    );
  }
  return new SQL(url, options);
}

/**
 * The Prisma driver adapter factory over `Deno.SQL`, for Postgres and SQLite. Pass it to
 * `new PrismaClient({ adapter })`.
 *
 * ```ts
 * new PrismaDenoSql("postgres://app:secret@db/app?schema=public");
 * new PrismaDenoSql("file:./prisma/dev.db");
 * new PrismaDenoSql(new Deno.SQL(url, { max: 20 })); // a client of your own
 * ```
 */
export class PrismaDenoSql implements SqlMigrationAwareDriverAdapterFactory {
  /** The adapter's name, as Prisma logs it. */
  readonly adapterName: string = ADAPTER_NAME;
  /** The database it speaks to. */
  readonly provider: "postgres" | "sqlite";
  readonly #url: string | null;
  readonly #client: DenoSqlClient | null;
  readonly #options: PrismaDenoSqlOptions;

  /**
   * Create the factory; nothing connects until Prisma calls {@linkcode connect}.
   *
   * @param target A connection URL, or a `Deno.SQL` client of your own.
   * @param options Adapter options.
   * @throws {TypeError} When the database cannot be told from `target` and no `provider` is set.
   */
  constructor(target: string | URL | DenoSqlClient, options: PrismaDenoSqlOptions = {}) {
    this.#options = options;
    if (typeof target === "string" || target instanceof URL) {
      this.#url = String(target);
      this.#client = null;
    } else {
      this.#url = null;
      this.#client = target;
    }
    this.provider = options.provider ?? targetProvider(this.#url, this.#client);
  }

  /** Open the adapter: on the passed client, or a new `Deno.SQL` client for the URL. */
  // deno-lint-ignore require-await -- async so a missing Deno.SQL rejects instead of throwing
  async connect(): Promise<SqlDriverAdapter> {
    if (this.#client) {
      const client = this.#client;
      const dispose = () => this.#options.disposeClient ? client.close() : Promise.resolve();
      return new DenoSqlAdapter(client, this.#driver(this.#options.schema), dispose);
    }
    return this.#open(this.#url!);
  }

  /**
   * Open an adapter on a throwaway shadow database for `prisma migrate`: Postgres creates a
   * database beside the URL's and drops it on `dispose()`; SQLite opens `shadowDatabaseUrl`
   * (default `:memory:`).
   *
   * @throws {Error} For Postgres when the adapter was given a client rather than a URL.
   */
  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    if (this.provider === "sqlite") {
      return this.#open(this.#options.shadowDatabaseUrl ?? ":memory:");
    }
    if (this.#options.shadowDatabaseUrl) return this.#open(this.#options.shadowDatabaseUrl);
    if (!this.#url) {
      throw new Error("denext/prisma-adapter: a shadow database needs a URL or shadowDatabaseUrl.");
    }
    const main = this.#open(this.#url);
    const name = `prisma_migrate_shadow_db_${crypto.randomUUID()}`;
    await main.executeScript(`CREATE DATABASE "${name}"`);
    const url = new URL(this.#url);
    url.pathname = `/${name}`;
    const shadow = this.#open(url.href);
    const dispose = shadow.dispose.bind(shadow);
    return Object.assign(shadow, {
      dispose: async () => {
        await dispose();
        await main.executeScript(`DROP DATABASE IF EXISTS "${name}"`);
        await main.dispose();
      },
    });
  }

  /** An adapter on a client of its own for `url`, closed on `dispose()`. */
  #open(url: string): DenoSqlAdapter {
    const extra = this.#options.sql ?? {};
    if (this.provider === "sqlite") {
      const client = openClient(url, { bigint: true, ...extra, adapter: "sqlite" });
      return new DenoSqlAdapter(client, this.#driver(undefined), () => client.close());
    }
    const conn = postgresConnection(url, this.#options.schema);
    const client = openClient(conn.url, { ...conn.options, ...extra });
    return new DenoSqlAdapter(client, this.#driver(conn.schema), () => client.close());
  }

  #driver(schema: string | undefined): Driver {
    return this.provider === "sqlite"
      ? sqliteDriver(this.#options.timestampFormat ?? "iso8601")
      : postgresDriver(schema);
  }
}
