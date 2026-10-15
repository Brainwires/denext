// Row-level security for `db()`, Supabase-compatible: every query runs inside a transaction that
// first sets the Postgres role (`anon` or `authenticated`) and `request.jwt.claims` with
// `set_config(…, true)` — transaction-local, so nothing outlives the transaction on a pooled
// connection (or behind pgbouncer in transaction mode). The `auth.uid()` / `auth.role()` /
// `auth.jwt()` / `auth.email()` functions Supabase policies call read those claims, so a policy
// written for Supabase (`using (auth.uid() = owner)`) works unchanged.
//
// The setup statement and the caller's query are pipelined: both are sent before either answer
// is read, on the transaction's one connection, in that order — the query never runs before the
// role is set, and a failed setup aborts the transaction so the query cannot run at all. A single
// scoped query hands both to `begin` unstarted, as an array returned synchronously
// (`begin(tx => [setup, query])`): `Deno.SQL` then sends BEGIN, both and COMMIT in one round trip
// (postgres.js runs the same shape).

import type { AuthSession, SqlClient, SqlQuery } from "@denext/denext/server";
import { bootMigrate, type Migration } from "@denext/denext/server";
import type { RequestIdentity } from "./identity.ts";

/**
 * The roles a scoped query runs as — Supabase's names. `service_role` (the secret key) runs as
 * the connecting role itself, with no row-level security, but with its claims set, so
 * `auth.role()` reads `service_role`.
 */
export type RlsRole = "anon" | "authenticated" | "service_role";

/** The Postgres role `set_config('role', …)` takes for a scope: `none` resets to the connecting role. */
export function pgRole(role: RlsRole): string {
  return role === "service_role" ? "none" : role;
}

/** `backend({ postgres: { rls } })`: how row-level security is set up. */
export interface RlsOptions {
  /**
   * Apply the `backend_rls_0001` migration (the `anon` / `authenticated` roles, their grant to
   * the connecting role, and the `auth.*` functions) on the first scoped query (default
   * `true`). `false` when a DBA applies {@linkcode rlsSetupSql} instead.
   */
  migrate?: boolean;
  /**
   * Extra claims for a signed-in user's `request.jwt.claims` (read in SQL with
   * `auth.jwt() ->> 'tenant'`). Merged over denext's own; `sub`, `role` and `email` cannot be
   * overridden.
   */
  claims?: (session: AuthSession) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** A user to act as, for `db({ as: user })` outside a request (a job, a script). */
export interface DbUser {
  /** The user id — `auth.uid()` in SQL (a UUID there, as in Supabase). */
  id: string;
  /** The email — `auth.email()`. */
  email?: string;
  /** The app's roles, in `auth.jwt() -> 'app_metadata' -> 'roles'`. */
  roles?: string[];
  /** Extra claims, as `rls.claims` adds them (`sub`, `role` and `email` cannot be overridden). */
  claims?: Record<string, unknown>;
}

/**
 * Who a `db()` client acts as: `"anon"`, a user (a {@linkcode DbUser} or a denext
 * `AuthSession`), a request's resolved identity (`resolveIdentity()`), or `"service"` — the
 * connecting role, with no row-level security at all.
 */
export type DbIdentity = "anon" | "service" | DbUser | AuthSession | RequestIdentity;

/** Options for `db()`. */
export interface DbOptions {
  /**
   * Act as this identity instead of the request's. Without it, `db()` acts as the request's
   * signed-in user (`auth()`), or as `anon` when nobody is signed in or there is no request.
   */
  as?: DbIdentity;
}

/** The role and claims one scoped query is run with. */
export interface RlsScope {
  /** The Postgres role. */
  role: RlsRole;
  /** The `request.jwt.claims` JSON. */
  claims: string;
}

/** The tracking table the backend's own migrations are recorded in. */
const BACKEND_MIGRATIONS_TABLE = "backend_migrations";

/**
 * The one statement that scopes a transaction: `set_config('role', …, true)` is
 * `SET LOCAL ROLE` (the form PostgREST uses, since `SET` cannot take a parameter), and
 * `request.jwt.claims` is what Supabase's `auth.*` functions read. All are transaction-local.
 *
 * Supabase's `auth.uid()` / `auth.role()` / `auth.email()` / `auth.jwt()` read the legacy
 * per-claim settings (`request.jwt.claim.sub`, …, `request.jwt.claim`) FIRST and fall back to
 * `request.jwt.claims` only when they are empty, so the statement blanks them too: a value left
 * on the connection's session (or set by the database's or role's defaults) never overrides the
 * identity this transaction runs as.
 */
export const RLS_SETUP = "select set_config('role', $1, true), " +
  "set_config('request.jwt.claims', $2, true), " +
  "set_config('request.jwt.claim.sub', '', true), " +
  "set_config('request.jwt.claim.role', '', true), " +
  "set_config('request.jwt.claim.email', '', true), " +
  "set_config('request.jwt.claim', '', true)";

/** The anonymous scope: Supabase's anon key carries `role: "anon"` and no subject. */
export const ANON_SCOPE: RlsScope = { role: "anon", claims: JSON.stringify({ role: "anon" }) };

/** `auth.*` — Supabase's definitions, verbatim (see {@linkcode rlsSetupSql}). */
const AUTH_FUNCTIONS: Array<[signature: string, body: string]> = [
  [
    "auth.uid()",
    `create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$`,
  ],
  [
    "auth.role()",
    `create or replace function auth.role()
returns text
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$`,
  ],
  [
    "auth.email()",
    `create or replace function auth.email()
returns text
language sql stable
as $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$`,
  ],
  [
    "auth.jwt()",
    `create or replace function auth.jwt()
returns jsonb
language sql stable
as $$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$`,
  ],
];

/** One `DO` block per role: create it when missing (a concurrent creator is not an error). */
function createRole(role: "anon" | "authenticated"): string {
  return `DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} NOLOGIN NOINHERIT;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $do$;`;
}

/**
 * Grant a role to the connecting role, so `SET LOCAL ROLE` to it is allowed. Skipped when the
 * connecting role can already switch to it (a superuser always can); a refusal names the fix.
 * Postgres 16 split "member of" from "may SET ROLE to", so the check asks for the right one.
 */
function grantRole(role: "anon" | "authenticated"): string {
  return `DO $do$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF pg_has_role(current_user, '${role}', 'SET') THEN RETURN; END IF;
  ELSIF pg_has_role(current_user, '${role}', 'MEMBER') THEN
    RETURN;
  END IF;
  EXECUTE format('GRANT ${role} TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'backend_rls_0001: % may not grant itself the role ${role}', current_user
    USING HINT = format('Have a database administrator run: GRANT anon, authenticated TO %I; '
      || 'see rlsSetupSql() in @denext/backend', current_user);
END $do$;`;
}

/** The `auth` schema and its functions — each created only when it does not exist yet. */
function authSchema(): string {
  const functions = AUTH_FUNCTIONS.map(([signature, body]) =>
    `  IF to_regprocedure('${signature}') IS NULL THEN
    EXECUTE $fn$${body}$fn$;
  END IF;`
  ).join("\n");
  return `CREATE SCHEMA IF NOT EXISTS auth;
DO $do$
BEGIN
${functions}
  IF NOT has_schema_privilege('anon', 'auth', 'USAGE') THEN
    GRANT USAGE ON SCHEMA auth TO anon;
  END IF;
  IF NOT has_schema_privilege('authenticated', 'auth', 'USAGE') THEN
    GRANT USAGE ON SCHEMA auth TO authenticated;
  END IF;
END $do$;`;
}

/**
 * The backend's row-level-security migration, `backend_rls_0001`, as `migratePostgres` takes
 * it: the `anon` and `authenticated` roles (`NOLOGIN NOINHERIT`, created when missing), their
 * grant to the connecting role, and the `auth` schema with Supabase's `auth.uid()`,
 * `auth.role()`, `auth.email()` and `auth.jwt()` (created when missing, so a database restored
 * from Supabase keeps its own).
 *
 * @returns The migrations, in order.
 */
export function rlsMigrations(): Migration[] {
  return [{
    name: "backend_rls_0001",
    sql: [
      createRole("anon"),
      createRole("authenticated"),
      grantRole("anon"),
      grantRole("authenticated"),
      authSchema(),
    ].join("\n"),
  }];
}

/** A plain role name, as Postgres would print it unquoted. */
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * The same setup as SQL for a database administrator to run once, when the app's own database
 * user may not create roles (then set `rls: { migrate: false }`). The `auth.*` functions are
 * Supabase's own definitions, from supabase/auth's
 * `migrations/20220224000811_update_auth_functions.up.sql` (`auth.jwt()` was added there; the
 * others are that file's current form).
 *
 * @param appRole The role the app connects as (it is granted `anon` and `authenticated`).
 * @returns The SQL.
 * @throws {TypeError} For a role name that is not a plain identifier.
 */
export function rlsSetupSql(appRole: string): string {
  if (!ROLE_NAME.test(appRole)) {
    throw new TypeError(`rlsSetupSql: ${JSON.stringify(appRole)} is not a plain role name`);
  }
  return [
    "-- @denext/backend row-level security (backend_rls_0001), for a database administrator.",
    createRole("anon"),
    createRole("authenticated"),
    `GRANT anon, authenticated TO "${appRole}";`,
    authSchema(),
    "",
  ].join("\n");
}

/** Supabase's assurance level: `aal2` once a second factor is part of the session. */
function aalOf(amr: readonly string[]): "aal1" | "aal2" {
  return amr.some((method) => method === "totp" || method === "bcp" || method === "mfa")
    ? "aal2"
    : "aal1";
}

/**
 * The `request.jwt.claims` for a signed-in user — the shape a Supabase access token has, so
 * `auth.jwt()` reads the same keys:
 *
 * `{ sub, role: "authenticated", aud: "authenticated", email?, exp?, iat?, session_id?,
 *   aal, amr: [{ method, timestamp? }], app_metadata: { provider, providers, roles },
 *   user_metadata: { name?, image?, email_verified? }, is_anonymous, ...custom }`
 *
 * `is_anonymous` is `true` for an anonymous user's session (`AuthUser.isAnonymous`).
 *
 * @param session The denext session.
 * @param custom Extra claims (`sub`, `role` and `email` are not overridden).
 * @returns The claims.
 */
export function sessionClaims(
  session: AuthSession,
  custom: Record<string, unknown> = {},
): Record<string, unknown> {
  const user = session.user;
  const amr = session.amr ?? [];
  const timestamp = session.authTime ?? session.issuedAt;
  const metadata: Record<string, unknown> = {};
  if (user.name !== undefined) metadata.name = user.name;
  if (user.image !== undefined) metadata.image = user.image;
  if (user.emailVerified !== undefined) metadata.email_verified = user.emailVerified;
  return {
    aud: "authenticated",
    ...(session.expiresAt ? { exp: session.expiresAt } : {}),
    ...(session.issuedAt ? { iat: session.issuedAt } : {}),
    ...(session.sessionId ? { session_id: session.sessionId } : {}),
    aal: aalOf(amr),
    amr: amr.map((method) => timestamp === undefined ? { method } : { method, timestamp }),
    app_metadata: {
      provider: session.provider,
      providers: [session.provider],
      roles: user.roles ?? [],
    },
    user_metadata: metadata,
    is_anonymous: user.isAnonymous === true,
    ...withoutIdentity(custom),
    ...identityClaims(user.id, user.email),
  };
}

/** The claims nothing may override: `email` comes from the user alone, or is absent. */
function identityClaims(id: string, email: string | undefined): Record<string, unknown> {
  return { sub: id, role: "authenticated", ...(email === undefined ? {} : { email }) };
}

/**
 * Custom claims without the identity keys (`sub`, `role`, `email`) — stripped, not just
 * overwritten, so a user without an email cannot be given one by the app's own claims.
 */
function withoutIdentity(custom: Record<string, unknown> | undefined): Record<string, unknown> {
  const { sub: _sub, role: _role, email: _email, ...rest } = custom ?? {};
  return rest;
}

/**
 * The claims for a {@linkcode DbUser} (`db({ as: user })`).
 *
 * @param user The user.
 * @returns The claims.
 */
export function userClaims(user: DbUser): Record<string, unknown> {
  return {
    aud: "authenticated",
    app_metadata: { roles: user.roles ?? [] },
    is_anonymous: false,
    ...withoutIdentity(user.claims),
    ...identityClaims(user.id, user.email),
  };
}

/** Whether a value is a denext `AuthSession` (it has a `user`) rather than a `DbUser`. */
export function isSession(value: DbUser | AuthSession | RequestIdentity): value is AuthSession {
  return typeof (value as AuthSession).user === "object" && (value as AuthSession).user !== null;
}

/** The scope for an authenticated identity. */
export function authenticatedScope(claims: Record<string, unknown>): RlsScope {
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new TypeError("db(): a user to act as needs a non-empty string id");
  }
  return { role: "authenticated", claims: JSON.stringify(claims) };
}

/** Start a query (or a value) now, as a promise — so it goes on the wire in call order. */
export function start<T>(value: PromiseLike<T> | T): Promise<T> {
  if (value === null || typeof (value as PromiseLike<T>)?.then !== "function") {
    return Promise.resolve(value as T);
  }
  return new Promise<T>((resolve, reject) => (value as PromiseLike<T>).then(resolve, reject));
}

/**
 * Run `work` inside an open transaction, scoped: the setup statement first, then the work,
 * pipelined. Both must succeed; a failed setup fails the transaction (rolled back by `begin`).
 *
 * @param tx The transaction's client.
 * @param scope The role and claims.
 * @param work The caller's query or callback.
 * @returns What `work` produced.
 */
async function inScope<T>(
  tx: SqlClient,
  scope: RlsScope,
  work: (tx: SqlClient) => PromiseLike<T> | T,
): Promise<T> {
  const setup = start(tx.unsafe(RLS_SETUP, [pgRole(scope.role), scope.claims]));
  let result: Promise<T>;
  try {
    result = start(work(tx));
  } catch (error) {
    result = Promise.reject(error);
  }
  const [, value] = await Promise.all([setup, result]);
  return value;
}

/**
 * Run one query scoped, in a transaction of its own: the callback returns the setup and the
 * query synchronously, both unstarted, so the driver can pipeline BEGIN, both and COMMIT
 * (`Deno.SQL`: one round trip; an async callback costs two). The driver awaits the array
 * together; the query's rows are returned, not the array.
 *
 * @param base The connecting role's client.
 * @param scope The role and claims.
 * @param query Builds the caller's query on the transaction's client (not started).
 * @returns The query's rows.
 */
async function scopedQuery<T>(
  base: SqlClient,
  scope: RlsScope,
  query: (tx: SqlClient) => PromiseLike<T[]>,
): Promise<T[]> {
  const settled = await (base.begin as unknown as (
    fn: (tx: SqlClient) => [PromiseLike<unknown>, PromiseLike<T[]>],
  ) => Promise<unknown>)((tx) => [
    tx.unsafe(RLS_SETUP, [pgRole(scope.role), scope.claims]),
    query(tx),
  ]);
  const rows = Array.isArray(settled) ? settled[1] : undefined;
  // A client whose begin() does not await a returned array would hand the queries back
  // unstarted — awaiting them now would run them outside the scoped transaction.
  if (!Array.isArray(rows)) {
    throw new TypeError(
      "db(): the Postgres client's begin() must await an array its callback returns " +
        "(Deno.SQL and postgres.js do)",
    );
  }
  return rows as T[];
}

/**
 * The client a scoped transaction's callback gets: the transaction's own, except that `begin`
 * opens a savepoint (Postgres has no nested transactions) and `close` is refused — every other
 * method (`unsafe`, `savepoint`, `Deno.SQL`'s helpers) runs on the same, scoped connection.
 */
function transactionHandle(tx: SqlClient): SqlClient {
  const nested = <T>(fn: (inner: SqlClient) => T | Promise<T>): Promise<T> => {
    if (!tx.savepoint) {
      return Promise.reject(
        new Error("db(): a nested begin() needs a client with savepoint() (Deno.SQL has one)"),
      );
    }
    return tx.savepoint((inner) => fn(transactionHandle(inner)));
  };
  return new Proxy(tx, {
    get(target, key) {
      if (key === "begin" || key === "savepoint") return nested;
      if (key === "close" || key === "end" || key === "reserve") {
        return () =>
          Promise.reject(new Error(`db(): ${String(key)}() is not available in a transaction`));
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A query that starts when first awaited (as a driver's own does), and only once. */
function lazyQuery<T>(run: () => Promise<T[]>, simple?: () => Promise<T[]>): SqlQuery<T> {
  let started: Promise<T[]> | undefined;
  const query: SqlQuery<T> = {
    then(onfulfilled, onrejected) {
      started ??= run();
      return started.then(onfulfilled, onrejected);
    },
  };
  if (simple) query.simple = () => lazyQuery(simple);
  return query;
}

/** Whether a call's first argument is a template's strings (`` sql`…` ``), not a helper value. */
function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as unknown as { raw?: unknown }).raw);
}

/**
 * A client whose every query runs scoped, each in a transaction of its own; `begin` scopes the
 * whole transaction once. The scope is resolved before a connection is taken, so resolving it
 * (reading the session, the first migration) never holds a pooled connection.
 *
 * Only the {@linkcode SqlClient} surface is offered: a driver's other methods (`reserve`,
 * `file`, `listen`) would run outside any scope, so they are not forwarded — use
 * `db.service()` for those, knowingly.
 *
 * @param base The connecting role's client.
 * @param scopeOf Called synchronously when a query is MADE (the template call, `unsafe`,
 *   `begin`) — so it sees the request that made it; returns what resolves that query's role and
 *   claims (and anything that must happen first) when the query runs.
 * @returns The scoped client.
 */
export function scopedClient(
  base: SqlClient,
  scopeOf: () => () => Promise<RlsScope>,
): SqlClient {
  const inTransaction = <T>(work: (tx: SqlClient) => PromiseLike<T> | T, options?: string) =>
    scopeOf()().then((resolved) => {
      const body = (tx: SqlClient) => inScope(tx, resolved, work);
      return options === undefined
        ? base.begin(body)
        : (base.begin as unknown as (o: string, f: typeof body) => Promise<T>)(options, body);
    });
  const oneQuery = <T>(
    scope: () => Promise<RlsScope>,
    query: (tx: SqlClient) => PromiseLike<T[]>,
  ) => scope().then((resolved) => scopedQuery(base, resolved, query));
  const client = ((first: unknown, ...rest: unknown[]) => {
    // `sql(object)` / `sql("name")` build a value (a helper or an identifier); nothing runs.
    if (!isTemplate(first)) {
      return (base as unknown as (...a: unknown[]) => unknown)(first, ...rest);
    }
    const scope = scopeOf();
    return lazyQuery(() => oneQuery(scope, (tx) => tx(first, ...rest)));
  }) as SqlClient;
  client.unsafe = <T>(text: string, params?: unknown[]) => {
    const scope = scopeOf();
    return lazyQuery<T>(
      () => oneQuery(scope, (tx) => tx.unsafe<T>(text, params)),
      () =>
        oneQuery(scope, (tx) => {
          const query = tx.unsafe<T>(text, params);
          return query.simple ? query.simple() : query;
        }),
    );
  };
  client.begin = (<T>(a: unknown, b?: unknown) => {
    const options = typeof a === "string" ? a : undefined;
    const fn = (typeof a === "function" ? a : b) as (tx: SqlClient) => T | Promise<T>;
    if (typeof fn !== "function") return Promise.reject(new TypeError("begin() needs a callback"));
    return inTransaction((tx) => fn(transactionHandle(tx)), options);
  }) as SqlClient["begin"];
  // The pool is the plugin's: a scoped handle never closes it.
  client.close = () => Promise.resolve();
  return client;
}

/** What a migration run is memoized under, per client: one run, retried after a failure. */
const migrated = new WeakMap<SqlClient, Promise<void>>();

type RootBridge = { __denextInRootContext?: <R>(fn: () => R) => R };

/**
 * Apply the RLS migration on `sql` once (concurrent first calls share the run; a failure is not
 * remembered, so the next query retries). Started in the root context: the request that
 * happens to trigger it must not leak into the connections the pool opens for it.
 *
 * @param sql The connecting role's client.
 * @returns When the migration has been applied.
 */
export function ensureRlsMigrated(sql: SqlClient): Promise<void> {
  let pending = migrated.get(sql);
  if (!pending) {
    const run = () =>
      bootMigrate(sql, {
        migrations: rlsMigrations(),
        table: BACKEND_MIGRATIONS_TABLE,
        feature: "backend({ postgres }) row-level security",
      });
    const inRoot = (globalThis as RootBridge).__denextInRootContext;
    pending = (inRoot ? inRoot(run) : run()).then(() => undefined, (error) => {
      migrated.delete(sql);
      throw error;
    });
    migrated.set(sql, pending);
  }
  return pending;
}
