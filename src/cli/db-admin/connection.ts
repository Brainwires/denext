// How the `db-admin` child reaches the project's database, and the transaction every one of its
// queries runs in.
//
// The client is the one the project itself would use: the `@denext/backend` plugin's (opened at
// its setup from `backend({ postgres })` — its `url`, or a `sql` client the app passed, which is
// how stock Deno gets one), else `DATABASE_URL` opened on `Deno.SQL`. The child reads the
// plugin's client from the process-global slot the plugin installs it in
// (`Symbol.for("denext.backend.postgres")`), the same slot `db()` reads.
//
// Every query runs inside a transaction that first sets `statement_timeout` (and
// `lock_timeout`) with `SET LOCAL`, so nothing outlives it on a pooled connection; a read is also
// `READ ONLY`, and one previewing another user's view sets that user's role and claims the way
// `@denext/backend`'s `db()` does.

import {
  isPostgresUrl,
  postgresClient,
  type SqlClient,
  type SqlQuery,
} from "../../server/postgres.ts";
import { type DbActor, maskSecrets } from "../../ui/database/protocol.ts";

/** The slot `@denext/backend` installs its client in (see packages/backend/src/postgres.ts). */
const BACKEND_POSTGRES = Symbol.for("denext.backend.postgres");

/** The backend's slot: its client, or why it has none. */
type BackendSlot = { sql: SqlClient } | { error: Error } | undefined;

/** A connection the child can query. */
export interface AdminConnection {
  /** The client. */
  readonly sql: SqlClient;
  /** The connection target, its password masked. */
  readonly display: string;
  /** Where it came from. */
  readonly source: "backend" | "env";
  /** Close it, when the child opened it (the plugin's is closed by its teardown). */
  close(): Promise<void>;
}

/** Why there is no connection: nothing configured, or no client on this Deno. */
export class ConnectionError extends Error {
  /**
   * Build the error.
   *
   * @param code `not_configured` or `unsupported`.
   * @param message The reason.
   */
  constructor(readonly code: "not_configured" | "unsupported", message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/**
 * A connection target for display: `postgres://user:•••@host:5432/db`.
 *
 * @param url The URL (or `undefined` when the client was passed in).
 * @returns The masked target.
 */
export function displayTarget(url: string | undefined): string {
  if (!url) return "the client passed to backend({ postgres: { sql } })";
  try {
    const parsed = new URL(url);
    // Assembled by hand: assigning the mask to `password` would percent-encode it.
    const user = parsed.username ? `${parsed.username}${parsed.password ? ":•••" : ""}@` : "";
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return maskSecrets(url);
  }
}

/**
 * Open the project's connection.
 *
 * @param env Reads an environment variable.
 * @returns The connection.
 * @throws {ConnectionError} When none is configured, or this Deno has no client for one.
 */
export function openConnection(env: (name: string) => string | undefined): AdminConnection {
  const slot = (globalThis as { [BACKEND_POSTGRES]?: BackendSlot })[BACKEND_POSTGRES];
  const url = env("DATABASE_URL");
  if (slot && "sql" in slot) {
    return {
      sql: slot.sql,
      display: displayTarget(isPostgresUrl(url) ? url : undefined),
      source: "backend",
      close: () => Promise.resolve(),
    };
  }
  if (!isPostgresUrl(url)) {
    throw new ConnectionError(
      slot && "error" in slot ? "unsupported" : "not_configured",
      slot && "error" in slot
        ? maskSecrets(slot.error.message)
        : "no database: set DATABASE_URL to a postgres:// URL, or add backend({ postgres }) to the config",
    );
  }
  let sql: SqlClient;
  try {
    sql = postgresClient(url, "denext ui");
  } catch (error) {
    throw new ConnectionError("unsupported", maskSecrets((error as Error).message));
  }
  return { sql, display: displayTarget(url), source: "env", close: () => sql.close() };
}

/** How a transaction is set up. */
export interface TxOptions {
  /** Run `READ ONLY`. */
  readonly readOnly: boolean;
  /** `statement_timeout`, ms. */
  readonly timeoutMs: number;
  /** Who to run as (default: the connecting role — the service role). */
  readonly actor?: DbActor;
}

/** The claims a user preview runs with — the shape `@denext/backend`'s `db({ as: user })` sends. */
export function actorClaims(actor: DbActor): { role: string; claims: string } | null {
  if (actor.kind === "service") return null;
  if (actor.kind === "anon") return { role: "anon", claims: JSON.stringify({ role: "anon" }) };
  if (typeof actor.id !== "string" || actor.id === "") {
    throw new TypeError("a user to preview as needs an id");
  }
  return {
    role: "authenticated",
    claims: JSON.stringify({
      aud: "authenticated",
      app_metadata: { roles: [] },
      is_anonymous: false,
      sub: actor.id,
      role: "authenticated",
      ...(actor.email ? { email: actor.email } : {}),
    }),
  };
}

/**
 * Run `fn` in a transaction set up per `options`: `READ ONLY` first (it must precede any query),
 * then the timeouts, then the actor's role and claims.
 *
 * @param sql The client.
 * @param options Read-only, timeout and actor.
 * @param fn The work.
 * @returns What `fn` returned.
 */
export function inTransaction<T>(
  sql: SqlClient,
  options: TxOptions,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const ms = Math.max(1, Math.trunc(options.timeoutMs));
  const scope = options.actor ? actorClaims(options.actor) : null;
  return sql.begin(async (tx) => {
    if (options.readOnly) await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL statement_timeout = ${ms}`);
    await tx.unsafe(`SET LOCAL lock_timeout = ${Math.min(ms, 3000)}`);
    if (scope) {
      await tx.unsafe(
        "select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)",
        [scope.role, scope.claims],
      );
    }
    return await fn(tx);
  });
}

/**
 * A client whose every query runs under {@linkcode inTransaction}: a bare `unsafe()` becomes a
 * one-statement transaction, and `begin()` sets the timeouts first. What the migration runner is
 * handed, so even its own transactions carry the statement timeout.
 *
 * @param sql The client.
 * @param options Read-only and timeout.
 * @returns The guarded client.
 */
export function guardedClient(sql: SqlClient, options: TxOptions): SqlClient {
  const run = <T>(text: string, params?: unknown[]) =>
    inTransaction(sql, options, async (tx) => [...await tx.unsafe<T>(text, params)]);
  const client = (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    inTransaction(
      sql,
      options,
      async (tx) => [...await tx<T>(strings, ...values)],
    )) as unknown as SqlClient;
  client.unsafe = <T>(text: string, params?: unknown[]): SqlQuery<T> => {
    let started: Promise<T[]> | undefined;
    const go = () => started ??= run<T>(text, params);
    return {
      then: (ok, fail) => go().then(ok, fail),
      // A multi-statement script: the simple protocol, inside the same guarded transaction.
      simple: () =>
        inTransaction(sql, options, async (tx) => {
          const query = tx.unsafe<T>(text);
          return [...await (query.simple ? query.simple() : query)];
        }),
    } as SqlQuery<T>;
  };
  client.begin = <T>(fn: (tx: SqlClient) => T | Promise<T>) =>
    inTransaction(sql, options, async (tx) => await fn(tx));
  client.close = () => Promise.resolve();
  return client;
}
