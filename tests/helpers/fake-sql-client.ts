// A fake Postgres `SqlClient` over an in-memory node:sqlite database, for unit tests of
// denext's Postgres stores on any Deno (no server, no Deno.SQL). It speaks just enough of the
// dialect those stores use: `$n` parameters become SQLite's `?n`, Postgres-only statements
// (the advisory lock, CREATE SCHEMA) are answered without running, booleans and dates are
// bound the way SQLite can take them, and SQLite's errors carry the SQLSTATE a Postgres
// server would send (`42P01` no such table, `23505` unique violation).
//
// Real Postgres semantics (concurrency across connections, types) are covered by the
// integration tests in tests/postgres-integration.test.ts against a real server.

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import type { SqlClient, SqlQuery, SqlRow } from "../../src/server/postgres.ts";

/** What a test can see and steer. */
export interface FakeSqlClient extends SqlClient {
  /** Every statement sent, in order (after `$n` → `?n`). */
  readonly statements: string[];
  /** How many times `close()` ran. */
  readonly closes: number;
  /** Make the next statement matching `pattern` throw `error` (once). */
  failNext(pattern: RegExp, error: Error & { code?: string }): void;
  /** The underlying database, for direct reads. */
  readonly raw: DatabaseSync;
  /**
   * The settings `set_config(name, value, is_local)` made, as Postgres keeps them: a local one
   * lasts until the transaction ends (COMMIT or ROLLBACK), a session one until the client goes.
   */
  readonly settings: Map<string, string>;
}

type Bindable = null | number | bigint | string | Uint8Array;

/** A value as node:sqlite can bind it. */
function bindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "number" || typeof value === "bigint" || typeof value === "string" ||
    value instanceof Uint8Array
  ) return value;
  return JSON.stringify(value);
}

/** SQLite's error, with the SQLSTATE Postgres would have sent. */
function translate(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  const code = /no such table/i.test(message)
    ? "42P01"
    : /UNIQUE constraint failed/i.test(message)
    ? "23505"
    : undefined;
  if (code) Object.defineProperty(error, "code", { value: code, configurable: true });
  return error;
}

/** Statements the fake answers without running (Postgres-only, no SQLite equivalent). */
const SKIP = /^\s*(SELECT pg_advisory_xact_lock|CREATE SCHEMA)/i;

/**
 * Build the fake.
 *
 * @returns A fresh, empty fake client.
 */
export function fakeSqlClient(): FakeSqlClient {
  const raw = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const failures: Array<{ pattern: RegExp; error: Error }> = [];
  let closes = 0;
  let queue: Promise<unknown> = Promise.resolve();
  // `set_config` / `current_setting`, as Postgres scopes them: a local setting ends with the
  // transaction, a session one stays.
  const settings = new Map<string, string>();
  const session = new Map<string, string>();
  raw.function("set_config", (name: unknown, value: unknown, local: unknown) => {
    const key = String(name);
    const text = value === null ? "" : String(value);
    settings.set(key, text);
    if (!local) session.set(key, text);
    return text;
  });
  raw.function("current_setting", { varargs: true }, (name: unknown) => {
    return settings.get(String(name)) ?? null;
  });
  let savepoints = 0;
  const endTransaction = () => {
    settings.clear();
    for (const [key, value] of session) settings.set(key, value);
  };

  // As Postgres does: once a statement fails in a transaction, every statement but a rollback
  // fails (25P02) until the transaction (or a savepoint) is rolled back.
  let inTransaction = false;
  let aborted = false;
  // The fake is one SQLite connection, but a real server gives each transaction a connection of
  // its own: a statement issued outside `begin` (a status read, another runner's first look)
  // runs on another connection, so it neither sees a transaction's abort state nor poisons it
  // by failing. Only statements made inside a `begin` callback (`scoped`) do.
  const inBegin = new AsyncLocalStorage<boolean>();
  const transactionAborted = () => aborted && inBegin.getStore() === true;
  const abortTransaction = () => {
    if (inTransaction && inBegin.getStore() === true) aborted = true;
  };
  const run = (text: string, params: unknown[] = [], simple = false): SqlRow[] => {
    const sql = text.replace(/\$(\d+)/g, "?$1");
    statements.push(sql);
    if (sql === "BEGIN") inTransaction = true;
    if (/^(COMMIT|ROLLBACK)$/.test(sql)) inTransaction = aborted = false;
    if (sql.startsWith("ROLLBACK TO SAVEPOINT")) aborted = false;
    if (transactionAborted()) {
      throw Object.assign(
        new Error("current transaction is aborted, commands ignored until end of block"),
        { code: "25P02" },
      );
    }
    try {
      const failure = failures.findIndex((f) => f.pattern.test(sql));
      if (failure >= 0) throw failures.splice(failure, 1)[0].error;
      if (SKIP.test(sql)) return [];
      if (simple) {
        raw.exec(sql);
        return [];
      }
      return raw.prepare(sql).all(...params.map(bindable)) as SqlRow[];
    } catch (error) {
      abortTransaction();
      throw translate(error);
    }
  };

  const query = <T>(text: string, params?: unknown[]): SqlQuery<T> => {
    const settle = () => Promise.resolve().then(() => run(text, params) as T[]);
    return {
      then: (ok, fail) => settle().then(ok, fail),
      // Lazy as well, as a driver's own simple() query is: it starts when awaited.
      simple: () => ({
        then: (ok, fail) =>
          Promise.resolve().then(() => run(text, params, true) as T[]).then(ok, fail),
      }),
    };
  };

  const client =
    (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query<T>(strings.reduce((acc, s, i) => `${acc}$${i}${s}`), values)) as FakeSqlClient;
  Object.assign(client, {
    statements,
    raw,
    unsafe: query,
    failNext(pattern: RegExp, error: Error) {
      failures.push({ pattern, error });
    },
    settings,
    begin<T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T> {
      // One connection: transactions take turns, as they would each hold a pooled one.
      const next = queue.then(() =>
        inBegin.run(true, async () => {
          run("BEGIN");
          try {
            // An array of queries is awaited as a whole, as Deno.SQL and postgres.js do.
            const returned = fn(client);
            const result =
              (Array.isArray(returned) ? await Promise.all(returned) : await returned) as T;
            run("COMMIT");
            return result;
          } catch (error) {
            run("ROLLBACK");
            throw error;
          } finally {
            endTransaction();
          }
        })
      );
      queue = next.catch(() => {});
      return next;
    },
    async savepoint<T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T> {
      const name = `s${++savepoints}`;
      const saved = new Map(settings);
      run(`SAVEPOINT ${name}`);
      try {
        const result = await fn(client);
        run(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        run(`ROLLBACK TO SAVEPOINT ${name}`);
        settings.clear();
        for (const [key, value] of saved) settings.set(key, value);
        throw error;
      }
    },
    close() {
      closes++;
      return Promise.resolve();
    },
  });
  Object.defineProperty(client, "closes", { get: () => closes });
  return client;
}
