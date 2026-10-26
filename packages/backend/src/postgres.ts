// Postgres for `@denext/backend`: the plugin opens (or adopts) one client at setup and shares it
// through a process-global slot, the way storage does — `db()` from `@denext/backend/server`
// reads it from the app's own modules, which a production build may have bundled into a separate
// copy of this package. `backendAuthAdapter()` puts denext auth's tables on that same client.

import {
  type AuthAdapter,
  type AuthSession,
  postgresAuthAdapter,
  type PostgresAuthAdapterOptions,
  postgresClient,
  sessionClient,
  type SqlClient,
  withDirectConnection,
} from "@denext/denext/server";
import { identityScope, isRequestIdentity, resolveIdentity } from "./identity.ts";
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
   * A client to use instead of `url`: any `SqlClient` (where `Deno.SQL` is missing, such as Deno
   * Deploy's upstream Deno, `fromPostgresJs(postgres(url))` with the npm `postgres` package). It is never closed by the
   * plugin.
   */
  sql?: SqlClient;
  /**
   * A direct `postgres://` URL to the same database (default: `DATABASE_DIRECT_URL`), for when
   * `url` / `sql` is a pooler in transaction mode (PgBouncer, Supavisor). What needs a session of
   * its own runs on it: realtime's LISTEN, its reserved connections (`revalidate.owner: "one"`,
   * the logical source), webhook delivery's wake-up, the REST schema-reload listener, and every
   * migration and its lock. Queries, `db()` included, keep using the pooled one.
   */
  directUrl?: string;
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
 * the slot carries the error, so `db()` explains it where it is used and a build that never
 * queries still succeeds.
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
  const directUrl = options.directUrl ?? env("DATABASE_DIRECT_URL");
  if (options.sql) {
    if (!options.directUrl) return { slot: { sql: options.sql, rls }, owned: false };
    // Yours stays open: closing the pair closes only the direct connection it opened.
    const direct = postgresClient(options.directUrl, "backend({ postgres })");
    return {
      slot: { sql: withDirectConnection(options.sql, direct, { pooled: false }), rls },
      owned: true,
    };
  }
  const url = options.url ?? env("DATABASE_URL");
  if (!url) {
    return {
      slot: { error: new Error("backend(): postgres needs `url` (or DATABASE_URL) or `sql`") },
      owned: false,
    };
  }
  try {
    const pooled = postgresClient(url, "backend({ postgres })");
    const sql = directUrl
      ? withDirectConnection(pooled, postgresClient(directUrl, "backend({ postgres })"))
      : pooled;
    return { slot: { sql, rls }, owned: true };
  } catch (error) {
    return { slot: { error: error as Error }, owned: false };
  }
}

/** The request context the code runs in, or `undefined` (a job, a script, module load). */
function currentRequestContext(): object | undefined {
  const context = (globalThis as ContextBridge).__denextCurrentRequestContext?.();
  return context?.request ? context : undefined;
}

type ContextBridge = { __denextCurrentRequestContext?: () => { request?: Request } | undefined };

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

/** Each request's resolved identity, so its queries read the session once. */
const requestScopes = new WeakMap<object, Promise<RlsScope>>();

/**
 * The identity of the request current right now — read for each query as it is made, never when
 * the client was made, so a `db()` client kept at module scope always acts as the visitor whose
 * request makes the query, and as `anon` outside any request (fail closed). The request's
 * identity is {@linkcode resolveIdentity}'s: a Supabase access token or API key when
 * `backend({ supabase })` is on, else the denext session. Memoized per request context; a failed
 * read is not remembered.
 */
function currentScope(rls: RlsOptions): Promise<RlsScope> {
  const context = currentRequestContext() as { request?: Request } | undefined;
  if (!context) return Promise.resolve(ANON_SCOPE);
  let pending = requestScopes.get(context);
  if (!pending) {
    pending = resolveIdentity(context.request, { rls }).then(identityScope);
    requestScopes.set(context, pending);
    pending.catch(() => requestScopes.delete(context));
  }
  return pending;
}

/**
 * Resolve an explicit identity (`db({ as })`), once: it never depends on the request.
 * Without one, the current request's identity (see {@linkcode currentScope}).
 */
function identityOf(
  as: Exclude<DbIdentity, "service"> | undefined,
  rls: RlsOptions,
): Promise<RlsScope> {
  if (as === "anon") return Promise.resolve(ANON_SCOPE);
  if (as === undefined) return currentScope(rls);
  if (isRequestIdentity(as)) return Promise.resolve().then(() => identityScope(as));
  return isSession(as)
    ? sessionScope(as, rls)
    : Promise.resolve().then(() => authenticatedScope(userClaims(as)));
}

/** `db()`: the app's Postgres, scoped by row-level security; `db.service()` bypasses it. */
export interface Db {
  /**
   * The app's Postgres client, scoped: every query runs as `authenticated` with the user of the
   * request current when the QUERY is made in `request.jwt.claims` (or as `anon`), so the tables'
   * RLS policies decide what it sees — a client kept at module scope is fine. Outside a request
   * it is `anon` unless `as` fixes an identity.
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
 * // A job acting for a user, or as the server itself:
 * await db({ as: { id: userId } })`insert into notes (owner, body) values (${userId}, ${body})`;
 * await db.service()`delete from notes where created_at < now() - interval '1 year'`;
 * ```
 *
 * Without `as`, who a query acts as is read when the query is made, from the request current at
 * that moment — so `const sql = db()` at module scope serves every visitor as themself, and is
 * `anon` outside a request. `db({ as })` is fixed to that identity wherever it runs.
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
    // An explicit identity is fixed when the client is made; without one, each query takes the
    // request current when the query is made (its session read once per request).
    const fixed = options.as === undefined ? undefined : identityOf(options.as, rls);
    // Settled by the first query; a client never queried must not leave a rejection unhandled.
    fixed?.catch(() => {});
    const ready = rls.migrate === false ? Promise.resolve() : undefined;
    return scopedClient(sql, () => {
      const identity = fixed ?? currentScope(rls);
      identity.catch(() => {});
      return () =>
        Promise.all([ready ?? ensureRlsMigrated(sql), identity]).then(([, scope]) => scope);
    });
  },
  {
    service(): SqlClient {
      return installed().sql;
    },
  },
);

/**
 * Who a query would run as, resolved now: `as` when given, else the current request's user (or
 * `anon` outside a request) — what `db()` binds. Used by realtime to re-read rows per
 * subscriber.
 *
 * @param as An explicit identity.
 * @returns The scope.
 */
export function resolveScope(as?: Exclude<DbIdentity, "service">): Promise<RlsScope> {
  return identityOf(as, installed().rls);
}

/**
 * A client scoped to an already resolved identity (the RLS migration still runs first, unless
 * `rls.migrate` is `false`).
 *
 * @param scope The role and claims.
 * @returns The scoped client.
 */
export function scopedFor(scope: RlsScope): SqlClient {
  const { sql, rls } = installed();
  const ready = rls.migrate === false ? Promise.resolve() : undefined;
  return scopedClient(sql, () => () => (ready ?? ensureRlsMigrated(sql)).then(() => scope));
}

/**
 * Resolves once the RLS migration has been applied (at once when `rls.migrate` is `false`), so
 * the `anon` / `authenticated` roles exist before anything asks about them.
 *
 * @returns When the roles are in place; rejects when Postgres is not configured.
 */
export function rlsReady(): Promise<void> {
  return Promise.resolve().then(() => {
    const { sql, rls } = installed();
    return rls.migrate === false ? undefined : ensureRlsMigrated(sql);
  });
}

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
  // Migrations go to the backend's direct connection, when it has one.
  Object.defineProperty(client, "direct", { get: () => sessionClient(db.service()) });
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
