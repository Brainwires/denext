// Postgres for `@denext/backend`: the plugin opens (or adopts) one client at setup and shares it
// through a process-global slot, the way storage does — `db()` from `@denext/backend/server`
// reads it from the app's own modules, which a production build may have bundled into a separate
// copy of this package. `backendAuthAdapter()` puts denext auth's tables on that same client.

import {
  auth,
  type AuthAdapter,
  type AuthSession,
  postgresAuthAdapter,
  type PostgresAuthAdapterOptions,
  postgresClient,
  type SqlClient,
} from "@denext/denext/server";
import {
  ANON_SCOPE,
  authenticatedScope,
  type DbIdentity,
  type DbOptions,
  ensureRlsMigrated,
  isSession,
  type RlsOptions,
  type RlsScope,
  scopedClient,
  sessionClaims,
  userClaims,
} from "./rls.ts";

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
  /**
   * Row-level security: `db()` runs every query as `anon` or `authenticated` with the request's
   * claims, so Supabase-style policies apply. The roles and `auth.*` functions are created by a
   * migration on first use unless `migrate: false`.
   */
  rls?: RlsOptions;
}

/** The installed client — or why there is none. */
export type PostgresSlot = { sql: SqlClient; rls?: RlsOptions } | { error: Error };

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
  const rls = options.rls ?? {};
  if (options.sql) return { slot: { sql: options.sql, rls }, owned: false };
  const url = options.url ?? env("DATABASE_URL");
  if (!url) {
    return {
      slot: { error: new Error("backend(): postgres needs `url` (or DATABASE_URL) or `sql`") },
      owned: false,
    };
  }
  try {
    return { slot: { sql: postgresClient(url, "backend({ postgres })"), rls }, owned: true };
  } catch (error) {
    return { slot: { error: error as Error }, owned: false };
  }
}

type ContextBridge = { __denextCurrentRequestContext?: () => { request?: Request } | undefined };

/** Whether this code runs inside a request (not a task, a script, or module load). */
function inRequest(): boolean {
  return !!(globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request;
}

/** The installed slot's client and RLS options, or the reason there is none. */
function installed(): { sql: SqlClient; rls: RlsOptions } {
  const slot = (globalThis as Holder)[SLOT];
  if (!slot) {
    throw new Error(
      "db(): Postgres is not configured: add backend({ postgres: { url } }) to denext.config.ts plugins",
    );
  }
  if ("error" in slot) throw slot.error;
  return { sql: slot.sql, rls: slot.rls ?? {} };
}

/** The scope for a signed-in session, with the app's own extra claims. */
async function sessionScope(session: AuthSession, rls: RlsOptions): Promise<RlsScope> {
  const custom = rls.claims ? await rls.claims(session) : undefined;
  return authenticatedScope(sessionClaims(session, custom ?? {}));
}

/**
 * Resolve who the client acts as. Called once per `db()` call, synchronously: a client made
 * inside a request reads THAT request's session (started now, so the identity is bound to the
 * request that asked even if a query runs later), and one made outside a request is `anon`
 * unless an identity is given.
 */
function identityOf(
  as: Exclude<DbIdentity, "service"> | undefined,
  rls: RlsOptions,
): Promise<RlsScope> {
  if (as === "anon") return Promise.resolve(ANON_SCOPE);
  if (as !== undefined) {
    return isSession(as)
      ? sessionScope(as, rls)
      : Promise.resolve().then(() => authenticatedScope(userClaims(as)));
  }
  if (!inRequest()) return Promise.resolve(ANON_SCOPE);
  return auth().then((session) => session ? sessionScope(session, rls) : ANON_SCOPE);
}

/** `db()`: the app's Postgres, scoped by row-level security; `db.service()` bypasses it. */
export interface Db {
  /**
   * The app's Postgres client, scoped: every query runs as `authenticated` with the request's
   * user in `request.jwt.claims` (or as `anon`), so the tables' RLS policies decide what it
   * sees. Outside a request it is `anon` unless `as` says otherwise.
   */
  (options?: DbOptions): SqlClient;
  /**
   * The connecting role's own client: **no row-level security** — every row of every table the
   * app's database user can reach. For migrations, maintenance tasks and admin code that has
   * already checked who is asking; never for a query shaped by a request's input on a user's
   * behalf.
   */
  service(): SqlClient;
}

/**
 * The app's Postgres client, from `backend({ postgres })`, scoped by row-level security — a
 * tagged-template query function:
 *
 * ```ts
 * import { db } from "@denext/backend/server";
 * // Inside a request: runs as the signed-in user (`auth.uid()` in your policies), else as anon.
 * const notes = await db()`select id, body from notes order by id`;
 * // A task acting for a user, or as the server itself:
 * await db({ as: { id: userId } })`insert into notes (owner, body) values (${userId}, ${body})`;
 * await db.service()`delete from notes where created_at < now() - interval '1 year'`;
 * ```
 *
 * Every interpolated value is a bound parameter. Each query runs in a transaction of its own
 * that first sets the role and claims (transaction-local, so nothing lingers on a pooled
 * connection); `db().begin(fn)` scopes a whole transaction, and a `begin` inside it is a
 * savepoint. `db({ as: "service" })` is `db.service()`.
 *
 * @param options `as`: the identity to act as instead of the request's.
 * @returns The scoped client.
 * @throws {Error} When `backend({ postgres })` is not configured.
 * @throws {PostgresUnsupportedError} On a Deno without `Deno.SQL` when no `sql` client was given.
 */
export const db: Db = Object.assign(
  (options: DbOptions = {}): SqlClient => {
    const { sql, rls } = installed();
    if (options.as === "service") return sql;
    const identity = identityOf(options.as, rls);
    // Settled by the first query; a client never queried must not leave a rejection unhandled.
    identity.catch(() => {});
    const ready = rls.migrate === false ? Promise.resolve() : undefined;
    return scopedClient(
      sql,
      () => Promise.all([ready ?? ensureRlsMigrated(sql), identity]).then(([, scope]) => scope),
    );
  },
  {
    service(): SqlClient {
      return installed().sql;
    },
  },
);

/**
 * The connecting role's client (`db.service()`), resolved on every call so it can be built
 * before the plugin's setup — what denext auth's own tables are reached through.
 */
export function deferredClient(): SqlClient {
  const client =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      db.service()(strings, ...values)) as SqlClient;
  client.unsafe = (text, params) => db.service().unsafe(text, params);
  client.begin = (fn) => db.service().begin(fn);
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
