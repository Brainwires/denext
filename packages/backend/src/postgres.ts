// Postgres for `@denext/backend`: the plugin opens (or adopts) one client at setup and shares it
// through a process-global slot, the way storage does — `db()` from `@denext/backend/server`
// reads it from the app's own modules, which a production build may have bundled into a separate
// copy of this package. `backendAuthAdapter()` puts denext auth's tables on that same client.

import {
  type AuthAdapter,
  postgresAuthAdapter,
  type PostgresAuthAdapterOptions,
  postgresClient,
  type SqlClient,
} from "@denext/denext/server";

/** `backend({ postgres })`: where the app's Postgres is. */
export interface PostgresOptions {
  /**
   * A `postgres://` URL (default: `DATABASE_URL`), opened with `Deno.SQL` — the Postgres client
   * built into denext's Deno runtime — and closed when the server drains.
   */
  url?: string;
  /**
   * A client to use instead of `url`: any `SqlClient` (on stock Deno,
   * `fromPostgresJs(postgres(url))` with the npm `postgres` package). It is never closed by the
   * plugin.
   */
  sql?: SqlClient;
}

/** The installed client — or why there is none. */
export type PostgresSlot = { sql: SqlClient } | { error: Error };

const SLOT = Symbol.for("denext.backend.postgres");
type Holder = { [SLOT]?: PostgresSlot };

/**
 * Install the client (plugin setup), or clear it with `undefined` (tests).
 *
 * @param slot The client, or the error `db()` should throw.
 */
export function installPostgres(slot: PostgresSlot | undefined): void {
  (globalThis as Holder)[SLOT] = slot;
}

/**
 * Open the configured client. Never throws: on a Deno without `Deno.SQL` (and no `sql` given)
 * the slot carries the error, so `db()` explains it where it is used and a build on stock Deno
 * still succeeds.
 *
 * @param options The `postgres` options.
 * @param env Reads an environment variable.
 * @returns The slot, and whether the plugin opened (and so must close) the client.
 */
export function openPostgres(
  options: PostgresOptions,
  env: (name: string) => string | undefined,
): { slot: PostgresSlot; owned: boolean } {
  if (options.sql) return { slot: { sql: options.sql }, owned: false };
  const url = options.url ?? env("DATABASE_URL");
  if (!url) {
    return {
      slot: { error: new Error("backend(): postgres needs `url` (or DATABASE_URL) or `sql`") },
      owned: false,
    };
  }
  try {
    return { slot: { sql: postgresClient(url, "backend({ postgres })") }, owned: true };
  } catch (error) {
    return { slot: { error: error as Error }, owned: false };
  }
}

/**
 * The app's Postgres client, from `backend({ postgres })` — a tagged-template query function:
 *
 * ```ts
 * import { db } from "@denext/backend/server";
 * const rows = await db()`select id, title from posts where author = ${userId}`;
 * ```
 *
 * Every interpolated value is a bound parameter. This client is the server's own: it is not
 * scoped to the request's user (row-level security is a later release).
 *
 * @returns The client.
 * @throws {Error} When `backend({ postgres })` is not configured.
 * @throws {PostgresUnsupportedError} On a Deno without `Deno.SQL` when no `sql` client was given.
 */
export function db(): SqlClient {
  const slot = (globalThis as Holder)[SLOT];
  if (!slot) {
    throw new Error(
      "db(): Postgres is not configured: add backend({ postgres: { url } }) to denext.config.ts plugins",
    );
  }
  if ("error" in slot) throw slot.error;
  return slot.sql;
}

/** A client that resolves `db()` on every call, so it can be built before the plugin's setup. */
export function deferredClient(): SqlClient {
  const client =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      db()(strings, ...values)) as SqlClient;
  client.unsafe = (text, params) => db().unsafe(text, params);
  client.begin = (fn) => db().begin(fn);
  client.close = () => Promise.resolve(); // the plugin owns the pool
  return client;
}

/** Options for {@linkcode backendAuthAdapter}: the adapter's own, without a connection. */
export type BackendAuthAdapterOptions = Omit<PostgresAuthAdapterOptions, "sql" | "url">;

/**
 * denext auth's adapter on the backend's Postgres: `postgresAuthAdapter` over the client
 * `backend({ postgres })` opens, so users, sessions and the app's own tables share one database.
 *
 * ```ts
 * // denext.config.ts
 * import { denextAuth, github } from "denext/server";
 * import { backend, backendAuthAdapter } from "@denext/backend";
 * export default {
 *   plugins: [
 *     backend({ postgres: { url: Deno.env.get("DATABASE_URL") } }),
 *     denextAuth({ providers: [github()], adapter: backendAuthAdapter() }),
 *   ],
 * };
 * ```
 *
 * It can be built before the plugin's setup runs: the client is looked up on each call.
 *
 * @param options An optional `schema`, `migrate: false`, a clock and the sweep interval.
 * @returns The adapter.
 */
export function backendAuthAdapter(options: BackendAuthAdapterOptions = {}): AuthAdapter {
  return postgresAuthAdapter({ ...options, sql: deferredClient() });
}
